#!/usr/bin/env python3
"""Export WordPress content to Astro-ready JSON, mirroring media to Cloudflare R2.

Usage:
    python wordpress_export.py --wordpress-url https://example.org --output content.json
    python wordpress_export.py --wordpress-url https://site.com --output content.json --skip-media
    python wordpress_export.py --output content.json --media-only

See README.md ("WordPress extraction") for the full workflow.
"""
import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
import logging
import mimetypes
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

import requests

log = logging.getLogger("wordpress_export")

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg", ".bmp", ".tif", ".tiff"}
# Linked documents are mirrored too, so they keep working once WordPress is switched off.
DOCUMENT_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp"}
MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | DOCUMENT_EXTENSIONS

# Map WordPress post types to the collections Astro reads.
COLLECTION_FOR_TYPE = {
    "post": "posts",
    "page": "pages",
}

# <img src>, srcset, lazy-load attributes and gallery "full size" attributes.
IMG_ATTR_RE = re.compile(
    r"""(?P<attr>\b(?:src|data-src|data-lazy-src|data-full-url|data-orig-file|data-large-file|data-medium-file|href))\s*=\s*(?P<q>["'])(?P<url>.*?)(?P=q)""",
    re.IGNORECASE,
)
SRCSET_RE = re.compile(
    r"""(?P<attr>\b(?:srcset|data-srcset|data-lazy-srcset))\s*=\s*(?P<q>["'])(?P<val>.*?)(?P=q)""",
    re.IGNORECASE,
)
MARKDOWN_IMG_RE = re.compile(r"!\[[^\]]*\]\((?P<url>[^)\s]+)(?:\s+\"[^\"]*\")?\)")
# Any absolute or protocol-relative URL, wherever it appears (plugin data-* attributes, JSON, text).
ANY_URL_RE = re.compile(r"""(?:https?:)?//[^\s"'<>()\\]+""")
# Root-relative uploads paths in any attribute: src="/wp-content/uploads/…"
RELATIVE_UPLOAD_RE = re.compile(r"""(?<=["'(=\s])/wp-content/[^\s"'<>()\\]+""")
CSS_URL_RE = re.compile(r"""url\(\s*(?P<q>["']?)(?P<url>[^)"']+)(?P=q)\s*\)""", re.IGNORECASE)
TAG_RE = re.compile(r"<[^>]+>")


def load_env(path=".env"):
    """Minimal .env loader (KEY=VALUE lines); real environment variables win."""
    env_path = Path(path)
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def strip_html(value):
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", value or ""))).strip()


def is_image_url(url):
    return Path(urlparse(url).path.lower()).suffix in IMAGE_EXTENSIONS


def is_media_url(url):
    return Path(urlparse(url).path.lower()).suffix in MEDIA_EXTENSIONS


class R2Uploader:
    """Uploads media to an R2 bucket through its S3-compatible API."""

    def __init__(self, force=False):
        missing = [k for k in ("R2_BUCKET_NAME", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.environ.get(k)]
        if missing:
            raise SystemExit(f"Missing R2 settings in .env: {', '.join(missing)} (or pass --skip-media)")
        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            raise SystemExit("boto3 is required for media upload: pip install -r requirements.txt")

        self.bucket = os.environ["R2_BUCKET_NAME"]
        account = os.environ["R2_ACCOUNT_ID"]
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(retries={"max_attempts": 3, "mode": "standard"}),
        )
        # Public base for rewritten URLs: custom domain or r2.dev URL if configured.
        self.public_base = (os.environ.get("R2_PUBLIC_URL") or f"https://{self.bucket}.{account}.r2.cloudflarestorage.com").rstrip("/")
        self.force = force

    def public_url(self, key):
        return f"{self.public_base}/{key}"

    def exists(self, key):
        if self.force:
            return False
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except Exception:
            return False

    def upload(self, key, body, content_type):
        self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=body,
            ContentType=content_type,
            CacheControl="public, max-age=31536000, immutable",
        )


class WordPressExporter:
    def __init__(self, base_url, types, per_page=100, limit=None, timeout=30):
        self.base_url = base_url.rstrip("/")
        self.api_url = f"{self.base_url}/wp-json/wp/v2"
        self.types = types
        self.per_page = per_page
        self.limit = limit
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers["User-Agent"] = "wp-migration-platform/1.0 (+https://github.com/givingdata/wp-migration-platform)"

    # ---- WordPress API -------------------------------------------------

    def rest_bases(self):
        """Map requested post types to their REST route (custom types may differ)."""
        try:
            resp = self.session.get(f"{self.api_url}/types", timeout=self.timeout)
            resp.raise_for_status()
            available = resp.json()
        except (requests.RequestException, ValueError) as e:
            log.warning("Could not list post types (%s); using names as REST routes", e)
            return {t: t for t in self.types}

        bases = {}
        for requested in self.types:
            # Accept either the type slug ("post") or its REST base ("posts").
            match = next(
                (slug for slug, info in available.items() if requested in (slug, info.get("rest_base"))),
                None,
            )
            if match is None:
                log.warning("Post type '%s' not found on %s; skipping", requested, self.base_url)
                continue
            bases[match] = available[match].get("rest_base") or match
        return bases

    def fetch_type(self, rest_base):
        items, page = [], 1
        while True:
            url = f"{self.api_url}/{rest_base}"
            params = {"per_page": self.per_page, "page": page, "_embed": "1"}
            log.info("Fetching %s page %d", rest_base, page)
            try:
                resp = self.session.get(url, params=params, timeout=self.timeout)
            except requests.RequestException as e:
                log.warning("Request failed for %s page %d: %s", rest_base, page, e)
                break
            # WordPress returns 400 once page exceeds total pages.
            if resp.status_code == 400 and page > 1:
                break
            if resp.status_code != 200:
                log.warning("%s page %d returned HTTP %d", rest_base, page, resp.status_code)
                break
            batch = resp.json()
            if not batch:
                break
            items.extend(batch)
            if self.limit and len(items) >= self.limit:
                return items[: self.limit]
            total_pages = int(resp.headers.get("X-WP-TotalPages", page))
            if page >= total_pages:
                break
            page += 1
        return items

    # ---- Normalisation -------------------------------------------------

    @staticmethod
    def collection_for(post_type):
        if post_type in COLLECTION_FOR_TYPE:
            return COLLECTION_FOR_TYPE[post_type]
        lowered = post_type.lower()
        if "exhibition" in lowered:
            return "exhibitions"
        if "event" in lowered:
            return "events"
        return lowered if lowered.endswith("s") else f"{lowered}s"

    @staticmethod
    def singular(collection):
        return {"exhibitions": "exhibition", "events": "event", "posts": "post", "pages": "page"}.get(collection, collection.rstrip("s"))

    def normalise(self, item, collection):
        embedded = item.get("_embedded", {})
        featured = (embedded.get("wp:featuredmedia") or [{}])[0] or {}
        author = (embedded.get("author") or [{}])[0] or {}
        terms = [t for group in embedded.get("wp:term", []) or [] for t in (group or []) if isinstance(t, dict)]

        image = featured.get("source_url")
        image_alt = featured.get("alt_text") or strip_html((featured.get("title") or {}).get("rendered", ""))
        content_html = (item.get("content") or {}).get("rendered", "")
        excerpt = strip_html((item.get("excerpt") or {}).get("rendered", ""))

        return {
            "id": str(item.get("id")),
            "wpId": item.get("id"),
            "slug": item.get("slug"),
            "type": self.singular(collection),
            "title": strip_html((item.get("title") or {}).get("rendered", "")),
            "description": excerpt or strip_html(content_html)[:300],
            "content": content_html,
            "image": image,
            "imageAlt": image_alt or None,
            "date": (item.get("date") or "")[:10] or None,
            "dateTime": item.get("date"),
            "modified": item.get("modified"),
            "author": author.get("name"),
            "categories": [t["name"] for t in terms if t.get("taxonomy") == "category"],
            "tags": [t["name"] for t in terms if t.get("taxonomy") == "post_tag"],
            "link": item.get("link"),
            "parent": item.get("parent") or None,
            "menuOrder": item.get("menu_order"),
            "status": item.get("status"),
        }

    def export(self):
        data = {
            "exportedAt": datetime.now(timezone.utc).isoformat(),
            "siteUrl": self.base_url,
            "exhibitions": [],
            "events": [],
            "posts": [],
            "pages": [],
            "media": [],
        }
        for post_type, rest_base in self.rest_bases().items():
            collection = self.collection_for(post_type)
            items = [self.normalise(i, collection) for i in self.fetch_type(rest_base)]
            data.setdefault(collection, []).extend(items)
            log.info("%s: %d items", collection, len(items))
        data["menu"] = self.fetch_menu()
        return data

    def fetch_menu(self):
        """The site's main navigation, read from the homepage HTML (the REST API only exposes
        menus to logged-in users). Returns [{title, url, children: [...]}], [] if none found."""
        try:
            resp = self.session.get(self.base_url + "/", timeout=self.timeout)
            resp.raise_for_status()
        except requests.RequestException as e:
            log.warning("Could not fetch homepage for the menu: %s", e)
            return []
        menu = parse_menu(resp.text, self.base_url)
        log.info("menu: %d top-level items", len(menu))
        return menu


class MediaMirror:
    """Finds WordPress media referenced by content, uploads to R2 and rewrites URLs."""

    def __init__(self, site_url, uploader, session=None, timeout=60, include_external=False):
        self.site_host = urlparse(site_url).netloc.lower().removeprefix("www.")
        self.site_url = site_url
        self.uploader = uploader
        self.session = session or requests.Session()
        self.timeout = timeout
        self.include_external = include_external
        self.mapping = {}  # original URL -> R2 URL
        self.failed = {}  # original URL -> reason

    # ---- Discovery -----------------------------------------------------

    def normalise_url(self, url):
        url = html.unescape(url.strip())
        if url.startswith("//"):
            url = "https:" + url
        return urljoin(self.site_url + "/", url)

    def is_mirrorable(self, url):
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or not is_media_url(url):
            return False
        host = parsed.netloc.lower()
        host = host.removeprefix("www.")
        if host == self.site_host or host.endswith("." + self.site_host):
            return True
        # Jetpack's Photon CDN proxies site images: i0.wp.com/site.com/wp-content/...
        if re.match(r"^i\d\.wp\.com$", host) and parsed.path.lstrip("/").startswith(self.site_host):
            return True
        return self.include_external

    def find_urls(self, text):
        """Every media URL in HTML/markdown: <img>, srcset, gallery data-*, markdown, CSS url(),
        plus any other link to the site's images or documents, whatever attribute holds it."""
        if not text:
            return []
        found = [m.group("url") for m in IMG_ATTR_RE.finditer(text)]
        for m in SRCSET_RE.finditer(text):
            found.extend(part.strip().split(" ")[0] for part in m.group("val").split(",") if part.strip())
        found.extend(m.group("url") for m in MARKDOWN_IMG_RE.finditer(text))
        found.extend(m.group("url") for m in CSS_URL_RE.finditer(text))
        found.extend(m.group(0) for m in ANY_URL_RE.finditer(text))
        found.extend(m.group(0) for m in RELATIVE_UPLOAD_RE.finditer(text))
        urls = []
        for raw in found:
            url = self.normalise_url(raw.rstrip(".,;:"))
            if self.is_mirrorable(url) and url not in urls:
                urls.append(url)
        return urls

    # ---- Transfer ------------------------------------------------------

    def key_for(self, url):
        """Preserve the uploads path (e.g. 2024/05/photo.jpg) so filenames stay readable.

        Plugin galleries (e.g. NextGEN's /wp-content/gallery/) keep their folder name.
        """
        path = unquote(urlparse(url).path)
        if "/wp-content/uploads/" in path:
            rel = path.split("/wp-content/uploads/", 1)[1]
        elif "/wp-content/" in path:
            rel = path.split("/wp-content/", 1)[1]
        else:
            digest = hashlib.sha1(url.encode()).hexdigest()[:10]
            rel = f"external/{digest}-{Path(path).name}"
        rel = re.sub(r"[^A-Za-z0-9._/-]+", "-", rel).strip("/")
        return f"media/{rel}"

    def mirror(self, url):
        if url in self.mapping:
            return self.mapping[url]
        if url in self.failed:
            return None
        key = self.key_for(url)
        try:
            if not self.uploader.exists(key):
                resp = self.session.get(url, timeout=self.timeout)
                resp.raise_for_status()
                content_type = resp.headers.get("Content-Type", "").split(";")[0] or mimetypes.guess_type(key)[0] or "application/octet-stream"
                if is_image_url(url) and not content_type.startswith("image/"):
                    raise ValueError(f"not an image (Content-Type {content_type})")
                if content_type.startswith("text/html"):
                    raise ValueError("got an HTML page instead of the file")
                self.uploader.upload(key, resp.content, content_type)
                log.info("Uploaded %s", key)
            else:
                log.debug("Already in R2: %s", key)
        except Exception as e:  # keep going: one broken image must not stop the export
            log.warning("Skipping %s: %s", url, e)
            self.failed[url] = str(e)
            return None
        self.mapping[url] = self.uploader.public_url(key)
        return self.mapping[url]

    # ---- Rewriting -----------------------------------------------------

    def rewrite_text(self, text):
        if not text:
            return text

        def swap(url):
            return self.mapping.get(self.normalise_url(url), url)

        text = IMG_ATTR_RE.sub(lambda m: f'{m.group("attr")}={m.group("q")}{swap(m.group("url"))}{m.group("q")}', text)
        text = SRCSET_RE.sub(
            lambda m: f'{m.group("attr")}={m.group("q")}'
            + ", ".join(
                " ".join([swap(p.strip().split(" ")[0])] + p.strip().split(" ")[1:])
                for p in m.group("val").split(",")
                if p.strip()
            )
            + m.group("q"),
            text,
        )
        text = MARKDOWN_IMG_RE.sub(lambda m: m.group(0).replace(m.group("url"), swap(m.group("url"))), text)
        text = CSS_URL_RE.sub(lambda m: m.group(0).replace(m.group("url"), swap(m.group("url"))), text)
        return self._replace_everywhere(text)

    def _variants(self, url):
        """Spellings of one URL that may appear in content: http/https, with/without www,
        protocol-relative, and root-relative."""
        parsed = urlparse(url)
        hosts = {parsed.netloc, parsed.netloc.removeprefix("www."), "www." + parsed.netloc.removeprefix("www.")}
        rest = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        out = {f"{scheme}//{h}{rest}" for h in hosts for scheme in ("https:", "http:", "")}
        return out, rest

    def _replace_everywhere(self, text):
        """Swap every spelling of every mirrored URL, in any attribute or text, for its R2 URL."""
        if not self.mapping:
            return text
        if getattr(self, "_swap_re_size", None) != len(self.mapping):
            absolute, relative = {}, {}
            for src, dst in self.mapping.items():
                variants, rest = self._variants(src)
                absolute.update(dict.fromkeys(variants, dst))
                if rest.startswith("/wp-content/"):
                    relative[rest] = dst
            end = r"(?![\w\-/%]|\.\w)"  # don't match a prefix of a longer URL (a trailing full stop is fine)
            alt = lambda keys: "|".join(re.escape(k) for k in sorted(keys, key=len, reverse=True))
            self._abs_re = re.compile(f"(?:{alt(absolute)}){end}")
            self._rel_re = re.compile(f"(?<=[\"'(=\\s])(?:{alt(relative)}){end}") if relative else None
            self._abs, self._rel, self._swap_re_size = absolute, relative, len(self.mapping)
        text = self._abs_re.sub(lambda m: self._abs[m.group(0)], text)
        if self._rel_re:
            text = self._rel_re.sub(lambda m: self._rel[m.group(0)], text)
        return text

    def process(self, data, collections):
        for name in collections:
            for entry in data.get(name, []):
                urls = self.find_urls(entry.get("content"))
                if entry.get("image"):
                    urls.insert(0, self.normalise_url(entry["image"]))
                for url in urls:
                    if self.is_mirrorable(url):
                        self.mirror(url)
                entry["content"] = self.rewrite_text(entry.get("content"))
                if entry.get("image"):
                    entry["originalImage"] = entry.get("originalImage") or entry["image"]
                    entry["image"] = self.mapping.get(self.normalise_url(entry["image"]), entry["image"])
                entry["images"] = [self.mapping[u] for u in urls if u in self.mapping]

        data["media"] = sorted(
            [{"source": src, "url": dst, "key": self.key_for(src)} for src, dst in self.mapping.items()],
            key=lambda m: m["key"],
        )
        return data


NON_CONTENT_KEYS = {"media", "mediaErrors", "menu"}


def content_collections(data):
    return [k for k, v in data.items() if isinstance(v, list) and k not in NON_CONTENT_KEYS]


class _MenuParser(HTMLParser):
    """Builds a tree from nested <ul><li><a>…</a><ul class="sub-menu">…</ul></li></ul>."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = []
        self.stack = []  # lists being filled, one per open <ul>
        self.current = []  # open <li> items, innermost last
        self.link = None  # item whose <a> text is being read
        self.done = False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if tag == "ul":
            target = self.root if not self.stack else self.current[-1]["children"] if self.current else self.stack[-1]
            self.stack.append(target)
        elif tag == "li" and self.stack:
            item = {"title": "", "url": None, "children": []}
            self.stack[-1].append(item)
            self.current.append(item)
        elif tag == "a" and self.current and self.current[-1]["url"] is None and not self.current[-1]["title"]:
            self.current[-1]["url"] = dict(attrs).get("href") or None
            self.link = self.current[-1]

    def handle_endtag(self, tag):
        if self.done:
            return
        if tag == "a":
            self.link = None
        elif tag == "li" and self.current:
            self.current.pop()
        elif tag == "ul" and self.stack:
            self.stack.pop()
            self.done = not self.stack

    def handle_data(self, data):
        if self.link is not None:
            self.link["title"] = (self.link["title"] + " " + data).strip()


def parse_menu(page_html, base_url):
    """Find the primary navigation <ul> and return its items with site links made root-relative."""
    starts = [m for m in re.finditer(r"<ul\b[^>]*>", page_html) if "sub-menu" not in m.group(0)]
    ranked = [m for m in starts if re.search(r"primary", m.group(0), re.I)] or [
        m for m in starts if re.search(r"(id|class)=[\"'][^\"']*\bmenu", m.group(0), re.I)
    ]
    if not ranked:
        return []
    parser = _MenuParser()
    parser.feed(page_html[ranked[0].start():])
    site = urlparse(base_url).netloc.lower().removeprefix("www.")

    def clean(items):
        out = []
        for item in items:
            url = item["url"]
            if url and url.strip() not in ("#", ""):
                parsed = urlparse(urljoin(base_url + "/", url))
                if parsed.netloc.lower().removeprefix("www.") == site:
                    url = parsed.path or "/"
            else:
                url = None
            title = html.unescape(re.sub(r"\s+", " ", item["title"])).strip()
            if title:
                out.append({"title": title, "url": url, "children": clean(item["children"])})
        return out

    return clean(parser.root)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export WordPress content to Astro-ready JSON with media mirrored to Cloudflare R2.")
    parser.add_argument("--wordpress-url", help="Site root, e.g. https://example.org")
    parser.add_argument("--output", default="content.json", help="Output JSON path (default: content.json)")
    parser.add_argument(
        "--types",
        default="posts,pages,exhibitions,events",
        help="Comma-separated post types or REST routes to export; missing ones are skipped (default: %(default)s)",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--skip-media", action="store_true", help="Export content only; keep original WordPress image URLs")
    mode.add_argument("--media-only", action="store_true", help="Re-mirror media for an existing --output file without re-fetching content")
    parser.add_argument("--force", action="store_true", help="Re-upload media even if the object already exists in R2")
    parser.add_argument("--include-external", action="store_true", help="Also mirror images hosted on other domains")
    parser.add_argument("--limit", type=int, help="Max items per post type (handy for test runs)")
    parser.add_argument("--env-file", default=".env", help="Path to .env with R2 credentials (default: .env)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    load_env(args.env_file)
    output = Path(args.output)

    if args.media_only:
        if not output.exists():
            parser.error(f"--media-only needs an existing export at {output}")
        data = json.loads(output.read_text(encoding="utf-8"))
        # Restore original URLs so a changed R2 base or deleted objects are re-mirrored cleanly.
        originals = {m["url"]: m["source"] for m in data.get("media", [])}
        for name in content_collections(data):
            for entry in data[name]:
                if entry.get("originalImage"):
                    entry["image"] = entry["originalImage"]
                content = entry.get("content") or ""
                for r2_url, source in originals.items():
                    content = content.replace(r2_url, source)
                entry["content"] = content
        site_url = args.wordpress_url or data.get("siteUrl")
        if "menu" not in data and site_url:
            data["menu"] = WordPressExporter(site_url, []).fetch_menu()
    else:
        if not args.wordpress_url:
            parser.error("--wordpress-url is required unless --media-only is used")
        types = [t.strip() for t in args.types.split(",") if t.strip()]
        data = WordPressExporter(args.wordpress_url, types, limit=args.limit).export()
        site_url = args.wordpress_url

    if not args.skip_media:
        mirror = MediaMirror(site_url, R2Uploader(force=args.force), include_external=args.include_external)
        mirror.process(data, content_collections(data))
        log.info("Media: %d mirrored, %d skipped", len(mirror.mapping), len(mirror.failed))
        if mirror.failed:
            data["mediaErrors"] = [{"source": u, "error": e} for u, e in sorted(mirror.failed.items())]
        else:
            data.pop("mediaErrors", None)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"\n✓ Saved {output}")
    for name in content_collections(data):
        print(f"  - {len(data[name])} {name}")
    if not args.skip_media:
        print(f"  - {len(data.get('media', []))} media files in R2")
    return 0


if __name__ == "__main__":
    sys.exit(main())
