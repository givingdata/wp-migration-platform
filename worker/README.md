# Content Worker

Cloudflare Worker behind the staff form. One submission flows through:

```
POST /submit (multipart)
  → API key + HMAC-SHA256 check
  → image → R2 original + WebP variants (Images binding: resize + crop to the type's aspect ratio)
  → Claude (claude-opus-5, JSON-schema output) → clean title / slug / summary / HTML body
  → KV  content:<id>  (full record + status)
  → GitHub commit to content.json → Pages rebuild (see .github/workflows)
```

## Setup

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # local secrets
npm test                         # unit tests (auth, content merge, image sizing)
npm run dev                      # http://localhost:8787
```

Production resources and secrets are created by `scripts/deploy.sh`. Manually:

```bash
wrangler kv namespace create CONTENT      # put the id in wrangler.toml
wrangler r2 bucket create wp-migration-media
wrangler secret put API_KEY
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

| Setting | Where | Notes |
| --- | --- | --- |
| `API_KEY` | secret | Shared with the form; sent as `Authorization: Bearer` |
| `HMAC_SECRET` | secret, optional | Signing key; defaults to `API_KEY` |
| `ANTHROPIC_API_KEY` (or `CLAUDE_API_KEY`) | secret | Claude API key |
| `GITHUB_TOKEN` | secret | Fine-grained token with **Contents: read & write** on `GITHUB_REPO` |
| `GITHUB_REPO`, `GITHUB_BRANCH`, `CONTENT_PATH` | `[vars]` | Where entries are committed |
| `R2_PUBLIC_URL` | `[vars]` | Public base of the media bucket (custom domain / r2.dev) |
| `ALLOWED_ORIGINS` | `[vars]` | Comma-separated origins for CORS (the form's URL) |
| `SITE_NAME` | `[vars]` | Used in Claude's instructions |
| `CLAUDE_MODEL` | `[vars]`, optional | Defaults to `claude-opus-5` |
| `CONTENT` / `MEDIA` / `IMAGES` | bindings | KV, R2 bucket, Cloudflare Images |

Image rules (aspect ratio, breakpoints, accepted types, max size, quality) come from
`config/design-specs.json`, bundled at build time.

## API

### `POST /submit`

Headers:

```
Content-Type: multipart/form-data; boundary=…
Authorization: Bearer <API_KEY>
X-Timestamp: <unix seconds>
X-Signature: hex(HMAC-SHA256(HMAC_SECRET || API_KEY, "<X-Timestamp>." + <raw request body bytes>))
```

The signature covers the exact body bytes, so the client must sign the same serialized
multipart body it sends (`form/form-handler.js` does this). Requests more than 5 minutes
off the server clock are rejected.

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `type` | yes | `exhibition`, `event` or `post` (keys of `contentTypes` in design-specs) |
| `title` | yes | ≤ 200 chars |
| `description` | yes | ≤ 20 000 chars; free text, Claude formats it |
| `date` | yes | `YYYY-MM-DD` |
| `image` | no | JPEG/PNG/WebP, ≤ 10 MB |
| `endDate`, `time`, `location`, `author` | no | Accepted when listed in the type's `fields` |

Success — `201` (published) or `202` (saved but the GitHub commit failed):

```json
{
  "success": true,
  "published": true,
  "contentId": "0b6f…",
  "url": "https://media.example.org/media/uploads/0b6f…/1200.webp",
  "slug": "spring-boutique-day",
  "entry": { "id": "0b6f…", "type": "event", "title": "Spring Boutique Day", "image": "…", "imageVariants": { "300": "…", "600": "…" }, "…": "…" },
  "commit": { "commitSha": "…", "commitUrl": "…" },
  "message": "Content submitted and scheduled for rebuild"
}
```

Errors — `{ "success": false, "error": "…", "fields": { "<name>": "<problem>" } }`:

| Status | Cause |
| --- | --- |
| 400 | Validation failed (`fields` lists each problem) |
| 401 | Missing/wrong API key, bad signature, stale timestamp |
| 413 | Body larger than max upload + 1 MB, or description too long for Claude |
| 415 | Not multipart |
| 422 | Image couldn't be processed, or Claude declined the content |
| 500/502 | Server misconfiguration, Claude or GitHub failure |

### `GET /content/:id`, `GET /content`

Bearer API key required. Returns the KV record (`status`: `structured` → `committed`, or
`commit_failed` with `error`) or the latest 50 submissions.

### `GET /specs`, `GET /health`

Public. Design specs JSON (for the form) and a liveness check.

## Stored media layout (R2)

```
media/uploads/<contentId>/original.<ext>
media/uploads/<contentId>/<width>.webp      # one per breakpoint ≤ source width, cropped to the type's ratio
```

## Security notes

The form runs in the browser, so anyone who can load it can read `API_KEY`. Treat the key as
a rate-limiting/abuse speed bump, not a secret: put the form behind **Cloudflare Access** (or
another login) and rotate the key if it leaks. HMAC + timestamp prevents tampering and replay
of captured requests.
