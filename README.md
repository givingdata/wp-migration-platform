# WordPress → JAMstack Migration Platform

Moves a WordPress site to a static Astro site on Cloudflare Pages, with media in R2 and a
staff form (via a Cloudflare Worker + Claude) for ongoing content updates.

| Piece | Path | What it does |
| --- | --- | --- |
| Extraction | `wordpress_export.py` | WordPress REST API → `content.json`, media mirrored to R2 |
| Design specs | `config/design-specs.json` | Aspect ratios, breakpoints and fields per content type |
| Worker | `worker/` | Form endpoint: auth, image optimization → R2, Claude structuring, KV, GitHub commit ([docs](worker/README.md)) |

## WordPress extraction

`wordpress_export.py` pulls posts, pages and any custom types (e.g. exhibitions, events)
from the WordPress REST API, downloads every referenced image into Cloudflare R2, and
rewrites the image URLs in the output so the static site never touches WordPress again.

### Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # fill in R2_* values
```

| Variable | Purpose |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID (S3 endpoint is `https://<id>.r2.cloudflarestorage.com`) |
| `R2_BUCKET_NAME` | Bucket that receives media |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token (Object Read & Write) |
| `R2_PUBLIC_URL` | Public base for rewritten URLs — a custom domain or `https://pub-….r2.dev`. Strongly recommended: the fallback `*.r2.cloudflarestorage.com` URL is not publicly readable. |

### Usage

```bash
# Full export: content + media → R2
python wordpress_export.py --wordpress-url https://thecinderellaproject.com --output content.json

# Content only, original WordPress image URLs kept (no R2 credentials needed)
python wordpress_export.py --wordpress-url https://thecinderellaproject.com --output content.json --skip-media

# Re-mirror media for an existing export (e.g. after changing R2_PUBLIC_URL or clearing the bucket)
python wordpress_export.py --output content.json --media-only [--force]

# Quick test: first 3 items of each type
python wordpress_export.py --wordpress-url https://thecinderellaproject.com --output /tmp/test.json --skip-media --limit 3
```

| Flag | Meaning |
| --- | --- |
| `--types` | Post types / REST routes to export (default `posts,pages,exhibitions,events`; missing ones are skipped with a warning) |
| `--skip-media` | Don't touch R2; keep original URLs |
| `--media-only` | Don't re-fetch content; re-mirror media referenced in `--output` |
| `--force` | Re-upload even if the object already exists in R2 (otherwise existing keys are skipped) |
| `--include-external` | Also mirror images hosted on other domains |
| `--limit N` | Max items per type |

### What gets mirrored

- **Featured images** — from `_embedded["wp:featuredmedia"]`, written to `image` (the original is kept in `originalImage`).
- **Inline images** — `<img src>`, `srcset` (every size variant), lazy-load attributes (`data-src`, `data-lazy-src`, …).
- **Gallery blocks** — `data-full-url`, `data-orig-file`, `data-large-file` and links to full-size files; NextGEN `/wp-content/gallery/` images.
- **Markdown images** `![alt](url)` and CSS `url(...)` backgrounds.
- Jetpack Photon URLs (`i0.wp.com/<site>/…`).

Only images on the site's own domain are mirrored unless `--include-external` is set. R2 keys
preserve the WordPress path, e.g. `wp-content/uploads/2024/05/photo.jpg` → `media/2024/05/photo.jpg`,
and `wp-content/gallery/2019/x.jpg` → `media/gallery/2019/x.jpg`. A broken image is logged, listed
under `mediaErrors` in the output, and left pointing at its original URL; the export carries on.

### Output (`content.json`)

```json
{
  "exportedAt": "2026-09-22T20:00:00+00:00",
  "siteUrl": "https://thecinderellaproject.com",
  "exhibitions": [],
  "events": [],
  "posts": [
    {
      "id": "4678",
      "slug": "boutique-day-2020",
      "type": "post",
      "title": "Boutique Day 2020",
      "description": "On February 9, The Cinderella Project hosted over 200 students…",
      "content": "<p>…<img src=\"https://media.example.org/media/gallery/2019/Unknown-6.jpg\">…</p>",
      "image": null,
      "images": ["https://media.example.org/media/gallery/2019/Unknown-6.jpg"],
      "date": "2020-02-11",
      "author": "cinderella",
      "categories": ["Uncategorized"],
      "tags": [],
      "link": "https://thecinderellaproject.com/boutique-day-2020/"
    }
  ],
  "pages": [],
  "media": [{ "source": "https://thecinderellaproject.com/wp-content/gallery/2019/Unknown-6.jpg", "url": "https://media.example.org/media/gallery/2019/Unknown-6.jpg", "key": "media/gallery/2019/Unknown-6.jpg" }]
}
```

Custom post types are grouped by name: anything containing `exhibition` → `exhibitions`,
`event` → `events`. The Astro site (`site/`) reads `exhibitions`, `events`, `posts` and `pages`.

### Test run: thecinderellaproject.com

```text
$ python wordpress_export.py --wordpress-url https://thecinderellaproject.com --output content.json --skip-media --limit 3
WARNING Post type 'exhibitions' not found on https://thecinderellaproject.com; skipping
WARNING Post type 'events' not found on https://thecinderellaproject.com; skipping
INFO Fetching posts page 1
INFO posts: 3 items
INFO Fetching pages page 1
INFO pages: 3 items

✓ Saved content.json
  - 0 exhibitions
  - 0 events
  - 3 posts
  - 3 pages
```

The Cinderella site only has standard posts and pages. Its "Boutique Day 2020" post has a
14-image NextGEN gallery, all of which are picked up for mirroring. Run without `--skip-media`
(and with `.env` filled in) to upload them.
