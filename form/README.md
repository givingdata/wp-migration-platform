# Staff Content Form

A static, dependency-free form that staff use to add exhibitions, events and posts. It signs
each request and sends it to the Worker (`worker/`), which optimizes the image, has Claude tidy
the text, and publishes it to the site.

| File | Purpose |
| --- | --- |
| `index.html` | Markup + styles (responsive, dark-mode aware, WCAG-oriented) |
| `config.js` | Per-client settings: site name, Worker URL, API key |
| `form-handler.js` | Validation, image preview + crop guidance, submit/response handling |
| `signing.js` | HMAC-SHA256 signing, identical scheme to `worker/src/auth.js` |
| `mock-worker.mjs` | Local stand-in for the Worker (real auth check, fake publishing) |

## Try it locally

```bash
node form/mock-worker.mjs              # terminal 1 → http://localhost:8787
python3 -m http.server 8080 -d form    # terminal 2 → http://localhost:8080
```

`config.js` defaults to the mock (`workerUrl: "http://localhost:8787"`, `apiKey: "dev-api-key"`).
The mock logs each submission, returns realistic responses, and rejects bad keys/signatures
exactly like the real Worker. `MOCK_FAIL=commit node form/mock-worker.mjs` simulates the
"saved but not published" (202) path.

Against the real Worker locally: `cd worker && npm run dev` (port 8787, secrets from `.dev.vars`)
and make `apiKey` match `API_KEY` there.

## Configure for a client

Edit `config.js`:

```js
export default {
  siteName: "The Cinderella Project",
  workerUrl: "https://wp-migration-worker.<account>.workers.dev",
  apiKey: "<same value as the Worker's API_KEY secret>",
  hmacSecret: null,        // only if the Worker has a separate HMAC_SECRET
  designSpecs: null,       // optional offline fallback for GET /specs
};
```

Also add the form's URL to the Worker's `ALLOWED_ORIGINS` (CORS).

## Deploy

It's plain static files — host `form/` anywhere. Recommended: a separate Cloudflare Pages project
protected by **Cloudflare Access**, because the API key in `config.js` is readable by anyone
who can open the page:

```bash
npx wrangler pages deploy form --project-name cinderella-form
# Zero Trust → Access → Applications → add the Pages URL, allow staff emails only
```

`scripts/deploy.sh` does this as part of full setup.

## What staff see

1. **Type** — Exhibition / Event / Post. The extra fields shown (end date, time, location,
   author) come from that type's `fields` in `config/design-specs.json`.
2. **Title, description, date** — required. The description can be rough; Claude formats it.
3. **Image** (optional) — the requirements for the chosen type are shown under the picker
   (e.g. *Exhibition images: 1.5:1 aspect ratio, at least 300px wide*). After choosing a file
   they see the original with the crop area highlighted and a preview at the site's aspect
   ratio, plus warnings if more than 5% will be trimmed or the image is too small.
4. **Submit** — a spinner while the Worker works (up to ~2 minutes), then a success message
   and a cleared form, or a specific error. On failure the text they typed stays in the form.

## Accessibility

Native controls with visible labels, a fieldset/legend for the type choice, `aria-describedby`
hints and errors, `aria-invalid` on bad fields, focus moved to the first error or to the status
message (`role="status"`, `aria-live`), visible focus rings, sufficient contrast in light and
dark mode, reduced-motion spinner, and layouts down to 320px wide.

## Signing (must match the Worker)

```
body       = exact multipart bytes (the form serializes FormData once, then signs and sends those bytes)
X-Timestamp = unix seconds
X-Signature = hex(HMAC-SHA256(hmacSecret || apiKey, X-Timestamp + "." + body))
Authorization: Bearer <apiKey>
```
