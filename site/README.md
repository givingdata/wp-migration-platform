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

Collections read: `pages` plus one per content type (`posts`, `events`, `announcements`, and
`exhibitions` when a client has them; see `docs/CONTENT_TYPES.md`). Entries without `slug` or
`title` are skipped.

## Routes

| Path | Source |
| --- | --- |
| `/` | The WordPress homepage or `sections.json` if there is one (staff edit its text and pictures in the form's Edit existing → Designed pages); otherwise a featured exhibition (if any) and a row per type marked `homepage`. Current announcements show in a banner on top |
| `/news/`, `/events/`, `/announcements/`, … | One listing per content type (`src/pages/[listing].astro`); `upcoming` types split into current and past on `endDate` (or `date`) vs the build date |
| `/<slug>/` | Every entry — `src/pages/[...slug].astro` picks the layout from its type's `layout` |
| `/sitemap-index.xml`, `/robots.txt`, `/404.html` | Generated |

Slugs keep their WordPress URLs where possible (`/boutique-day-2020/`). If two entries share a
slug, or a slug clashes with a built-in route, later ones are namespaced by type
(`/event/open-house/`). Pages are routed first, so they keep their original URLs.

## Layouts

| Layout | Used for | Image |
| --- | --- | --- |
| `Exhibition.astro` | `layout: "exhibition"` | Full-width hero, 1.5:1 |
| `Event.astro` | `layout: "event"` | Square 1:1 beside the details (date, time, location) |
| `Post.astro` | `layout: "article"` (news, announcements) and pages | Featured image 16:9; pages omit date/author; a "Learn more" button when there's a `linkUrl` |

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
