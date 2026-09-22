# Static Site (Astro)

Renders `content.json` (from `wordpress_export.py` and the form Worker) as a static site for
Cloudflare Pages.

```bash
npm install            # from the repo root (npm workspace)
npm run dev            # http://localhost:3000 — uses sample data if ../content.json is missing
npm run build          # → site/dist/
```

## Content source

Looked up in order: `$CONTENT_PATH` (absolute, or relative to `site/`), `../content.json`,
`./content.json`. If none exists, **local** builds fall back to `src/data/sample-content.json`
(with a warning); builds with `CI` or `REQUIRE_CONTENT` set fail instead, so sample content can
never be deployed.

Collections read: `exhibitions`, `events`, `posts`, `pages` (see the root README for the entry
format). Entries without `slug` or `title` are skipped.

## Routes

| Path | Source |
| --- | --- |
| `/` | Featured current exhibition, other exhibitions, upcoming events, latest news |
| `/exhibitions/`, `/events/` | Current/upcoming and past, split on `endDate` (or `date`) vs today |
| `/news/` | All posts, newest first |
| `/<slug>/` | Every entry — `src/pages/[...slug].astro` picks the layout by `type` |
| `/sitemap-index.xml`, `/robots.txt`, `/404.html` | Generated |

Slugs keep their WordPress URLs where possible (`/boutique-day-2020/`). If two entries share a
slug, or a slug clashes with a built-in route, later ones are namespaced by type
(`/event/open-house/`). Pages are routed first, so they keep their original URLs.

## Layouts

| Layout | Used for | Image |
| --- | --- | --- |
| `Exhibition.astro` | `exhibition` | Full-width hero, 1.5:1 |
| `Event.astro` | `event` | Square 1:1 beside the details (date, time, location) |
| `Post.astro` | `post`, `page` | Featured image 16:9; pages omit date/author |

Aspect ratios and breakpoints come from `config/design-specs.json`.

## Images — `src/components/Image.astro`

Always renders an `<img>` with `width`/`height`, a locked `aspect-ratio`, `object-fit: cover`,
lazy loading (eager + `fetchpriority=high` for heroes) and a `sizes` hint. `srcset` depends on
the source:

1. **Worker uploads** (`imageVariants`) — the pre-cropped WebP variants the Worker stored in R2.
2. **Cloudflare Image Resizing** — `/cdn-cgi/image/width=…,height=…,fit=cover,format=auto/<R2 URL>`
   at 300/600/800/1200px. Enable with `PUBLIC_IMAGE_RESIZING=cloudflare` **only** once the site is
   on a custom domain with Image Transformations turned on (it does not work on `*.pages.dev`).
3. **Fallback** — the R2 original, cropped by CSS.

## SEO

Per page: `<title>`, meta description (from the entry's summary), canonical URL, Open Graph and
Twitter tags (with share image), JSON-LD (`Organization` plus `ExhibitionEvent`, `Event`,
`BlogPosting` or `WebPage`), sitemap and robots.txt.

## Settings (build-time env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `SITE_URL` | `https://thecinderellaproject.com` | Canonical origin, sitemap |
| `PUBLIC_SITE_NAME` | `The Cinderella Project` | Header, titles, structured data |
| `PUBLIC_SITE_TAGLINE` | — | Home page intro and default description |
| `PUBLIC_IMAGE_RESIZING` | `none` | `cloudflare` to enable `/cdn-cgi/image` srcsets |
| `CONTENT_PATH` | — | Explicit content.json path |

Requires Node 22.12+ (Astro 7).
