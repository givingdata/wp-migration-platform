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
never be deployed. The sample pictures in `public/sample/` are left out of any build that uses a
real `content.json`.

Collections read: `pages` plus one per content type (`posts`, `events`, `announcements`, and
`exhibitions` when a client has them; see `docs/CONTENT_TYPES.md`). Entries without `slug` or
`title` are skipped.

## Routes

| Path | Source |
| --- | --- |
| `/` | The WordPress homepage or `sections.json` if there is one (staff edit its text and pictures in the form's Edit existing → Designed pages); otherwise a row of cards per type marked `homepage` (led by the current exhibition when a client has the optional exhibition type). Current announcements show in a banner on top |
| `/news/`, `/events/`, `/announcements/`, … | One listing per content type (`src/pages/[listing].astro`); `upcoming` types split into current and past on `endDate` (or `date`) vs the build date |
| `/<slug>/` | Every entry — `src/pages/[...slug].astro` picks the layout from its type's `layout` |
| `/sitemap-index.xml`, `/robots.txt`, `/404.html` | Generated |

Slugs keep their WordPress URLs where possible (`/summer-fair-2020/`). If two entries share a
slug, or a slug clashes with a built-in route, later ones are namespaced by type
(`/event/open-house/`). Pages are routed first, so they keep their original URLs.

## Layouts

| Layout | Used for | Image |
| --- | --- | --- |
| `Exhibition.astro` | `layout: "exhibition"` (the optional exhibition type; no type uses it by default) | Full-width hero, 1.5:1 |
| `Event.astro` | `layout: "event"` | Square 1:1 beside the details (date, time, location) |
| `Post.astro` | `layout: "article"` (news, announcements) and pages | Featured image 16:9; pages omit date/author; a "Learn more" button when there's a `linkUrl` |

Aspect ratios and breakpoints come from `config/design-specs.json`, one ratio per content type. Each
client repo has its own copy, so a client can change a ratio (best before launch: photos already
uploaded stay cropped to the old one). Section images (hero, split, tiles) have their shapes set in
`src/styles/global.css` instead, and a preset can change them.

## Look

`config/theme.json` picks a preset from `src/lib/theme.ts` and overrides any of its tokens (colours,
fonts, corners, widths, logo; see `docs/DESIGN_HANDOFF.md`). A preset that needs more than tokens
(heading sizes, section styling) gets its own `src/styles/presets/<preset>.css`, which only sites
using that preset build in.

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
| `SITE_URL` | `https://example.org` | Canonical origin, sitemap |
| `PUBLIC_SITE_NAME` | `Your Organization` | Header, titles, structured data |
| `PUBLIC_SITE_TAGLINE` | — | Home page intro and default description |
| `PUBLIC_IMAGE_RESIZING` | `none` | `cloudflare` to enable `/cdn-cgi/image` srcsets |
| `CONTENT_PATH` | — | Explicit content.json path |

Requires Node 22.12+ (Astro 7).
