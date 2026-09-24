# Staff Content Form

A static, dependency-free form that staff use to add news, events and announcements (the
client's content types, `docs/CONTENT_TYPES.md`) and to edit or delete what's already on the
site. It signs each request and sends it to the Worker (`worker/`), which optimizes the image,
has Claude tidy the text, and publishes it to the site.

| File | Purpose |
| --- | --- |
| `index.html` | Markup + styles (responsive, dark-mode aware, WCAG-oriented) |
| `config.js` | Per-client settings: site name, Worker URL, API key |
| `form-handler.js` | Add new: validation, image preview + crop guidance, submit/response handling |
| `edit.js` | Edit existing: find, edit (simple editor or HTML), new pages, delete, Deleted items / put back |
| `menu.js` | Menu: rename, reorder, dropdowns, add/remove links, preview, save |
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

**Add new**

1. **Type**: one choice per content type (News / Event / Announcement by default). The extra
   fields shown (end date, time, location, author, link) and their labels come from that type
   in `config/design-specs.json`.
2. **Title, description, date** — required. The description can be rough; Claude formats it.
3. **Image** (optional) — the requirements for the chosen type are shown under the picker
   (e.g. *Event images: 1:1 aspect ratio, at least 300px wide*). After choosing a file
   they see the original with the crop area highlighted and a preview at the site's aspect
   ratio, plus warnings if more than 5% will be trimmed or the image is too small.
4. **Submit** — a spinner while the Worker works (up to ~2 minutes), then a success message
   and a cleared form, or a specific error. On failure the text they typed stays in the form.

**Edit existing**

1. Everything on the site, grouped (Pages, News, Events, …), with a search box.
2. Opening one shows its title, summary, the date/time/location/link fields its type has, and
   the body in a simple editor (bold, italic, headings, lists, links; **HTML** switches to the
   source). Pasted text keeps paragraphs but not fonts. The web address never changes.
3. **Save changes** commits only the fields that changed. If someone else changed it meanwhile,
   they're told and can reload it.
4. **Delete…** asks for confirmation and an optional reason (and, for a page in the menu, whether
   to take its menu link out too), then moves it to **Deleted items**, where **Put back** restores
   it, menu link included. The homepage can't be deleted.
5. **New page** (also *Add new → Page*): title, summary and text in the same editor. Pages are
   saved as written (Claude doesn't rewrite them); the address comes from the title. After
   creating one, **add it to the menu** jumps to the Menu tab with the link filled in.

**Menu**

The site's main menu as a list. The **menu bar** (top-level items) is part of the design, so by
default it's fixed: staff add, rename, reorder (↑ ↓) and remove the links *inside* existing
dropdowns, and **Add a link** (a page from the list, or any web address) only offers existing
dropdowns. Pages linked from the menu bar can't be deleted. The Worker enforces this too. For a
client whose staff should manage the whole menu, set `"menu": { "topLevel": "editable" }` in
`config/design-specs.json`; then top-level items can also be added, renamed, reordered, removed
and nested (**Into dropdown above** / **Out**). Links to addresses with no page are flagged. A preview shows the result; nothing
changes on the site until **Save menu** (one commit; **Undo my changes** reloads the saved menu).
Once the menu has been edited here, `wordpress_export.py --site-info-only` keeps it rather than
copying WordPress's menu again (`--overwrite-menu` to replace it).

Changes are labelled with the staff member's email when the form is behind Cloudflare Access
(the page reads `/cdn-cgi/access/get-identity`). `node form/mock-worker.mjs` supports editing
too: it works on a temporary copy of the sample content (or `MOCK_CONTENT_DIR`).

The form is deployed by `scripts/deploy.sh` the first time and by `.github/workflows/deploy-form.yml`
whenever `form/` changes (needs the `FORM_PROJECT` and `WORKER_URL` variables and the
`FORM_API_KEY` secret).

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
