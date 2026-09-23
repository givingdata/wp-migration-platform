# Deployment Checklist — New Client

Moving one WordPress site onto the platform. Budget about two hours, most of it waiting on DNS
and the first content export. Commands run from the repo root unless noted.

## 0. Before you start

- [ ] Access to the client's WordPress site URL (the REST API must be public: `https://<site>/wp-json/wp/v2/posts` returns JSON)
- [ ] A Cloudflare account for the client (or your organization's account), with R2 enabled
- [ ] The client's domain on Cloudflare DNS, if the site will use its own domain
- [ ] A Claude API key ([console.anthropic.com](https://console.anthropic.com))
- [ ] Node 22.12+, Python 3.9+, `gh` CLI (optional but saves step 4)

## 1. Create the client repo

- [ ] From the platform folder: `bash scripts/new-client.sh <client> [github-owner]`
      → private repo `<owner>/<client>-site` and a local clone in `../<client>-site`
      (its `upstream` remote is the platform, so `git pull upstream main` brings in platform fixes)
- [ ] `cd ../<client>-site && npm install` — do **all remaining steps in the client folder**
- [ ] Edit `config/design-specs.json` if the client's design needs different aspect ratios, breakpoints or fields

## 2. Cloudflare API token and login

- [ ] `cd worker && npx wrangler login` (for the setup script)
- [ ] Create an API token for CI: **My Profile → API Tokens → Create Token → Custom**, permissions:
  - Account · Workers Scripts · Edit
  - Account · Cloudflare Pages · Edit
  - Account · Workers KV Storage · Edit
  - Account · Workers R2 Storage · Edit
  - Zone · DNS · Edit (only if linking a custom domain)
- [ ] Note the **Account ID** (dashboard sidebar)

## 3. Create resources and first deploy

```bash
CLIENT_SLUG=<client> SITE_NAME="<Site Name>" SITE_DOMAIN=<domain.org> \
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<id> \
bash scripts/deploy.sh
```

It prompts for the Claude API key and a GitHub token, then:

- [ ] creates the KV namespace `<client>-content` and R2 bucket `<client>-media` (with public r2.dev URL)
- [ ] writes their IDs into `worker/wrangler.toml`
- [ ] deploys the Worker and sets its `API_KEY`, `CLAUDE_API_KEY`, `GITHUB_TOKEN` secrets
- [ ] creates Pages projects `<client>-site` and `<client>-form`, deploys the form with a generated config
- [ ] links `SITE_DOMAIN` to the site project (if API token given)
- [ ] optionally sets the GitHub secrets/variables (step 4)
- [ ] prints the **form API key** — save it in the password manager

GitHub token for the Worker: **Settings → Developer settings → Fine-grained tokens**, repository
access = only this repo, permission **Contents: Read and write**. Set an expiry reminder.

> Re-running the script is safe (resources are reused), but it generates a **new form API key**
> unless you pass the old one: `FORM_API_KEY=<saved key> bash scripts/deploy.sh`.

- [ ] Commit the configured Worker settings:
  `git add worker/wrangler.toml && git commit -m "Configure <client> resources" && git push`

## 4. GitHub secrets and variables

Skip if you let `deploy.sh` do it. Otherwise **Settings → Secrets and variables → Actions**:

| Secret | Used by | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | all deploys | Token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | all deploys | Account ID |
| `CLOUDFLARE_KV_NAMESPACE_ID` | deploy-worker (optional override) | From `wrangler.toml` |
| `CLOUDFLARE_R2_BUCKET_NAME` | deploy-worker (optional override) | `<client>-media` |
| `FORM_API_KEY` | deploy-worker → Worker `API_KEY` | Printed by deploy.sh — **must match the deployed form** |
| `CLAUDE_API_KEY` | deploy-worker → Worker secret | Claude API key |
| `CONTENT_REPO_TOKEN` | deploy-worker → Worker `GITHUB_TOKEN` | Fine-grained PAT (Contents: R/W). GitHub forbids secret names starting with `GITHUB_`, hence the name. |
| `CLOUDFLARE_R2_ACCESS_KEY_ID` / `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | not used by CI | Only needed locally by `wordpress_export.py` (store in the password manager or here for reference) |

| Variable | Value |
| --- | --- |
| `CLOUDFLARE_PAGES_PROJECT` | `<client>-site` |
| `SITE_URL` | `https://<domain>` (or `https://<client>-site.pages.dev`) |
| `SITE_NAME` | Site name |
| `SITE_TAGLINE` | Optional home-page tagline |
| `IMAGE_RESIZING` | `cloudflare` once on a custom domain with Image Transformations enabled; otherwise leave unset |
| `WORKER_URL` | Worker URL (enables the post-deploy health check) |

The deploy-worker workflow re-uploads `FORM_API_KEY`, `CLAUDE_API_KEY` and `CONTENT_REPO_TOKEN`
as Worker secrets on every deploy, so all three must be set.

## 5. Migrate the content

- [ ] Create an R2 API token: **R2 → Manage API tokens → Create**, Object Read & Write on `<client>-media`
- [ ] `cp .env.example .env` and fill in `R2_*` (use the public URL deploy.sh printed for `R2_PUBLIC_URL`)
- [ ] `pip install -r requirements.txt`
- [ ] Dry run: `python wordpress_export.py --wordpress-url https://<old-site> --output /tmp/test.json --skip-media --limit 3`
- [ ] Full run: `python wordpress_export.py --wordpress-url https://<old-site> --output content.json`
- [ ] Check the summary: counts per type, `mediaErrors` (if any) in content.json
- [ ] Spot-check locally: `npm run dev` → http://localhost:3000
- [ ] `git add content.json && git commit -m "Initial content import" && git push` → **Rebuild Site** workflow deploys

## 6. Custom domain and DNS

- [ ] Pages → `<client>-site` → Custom domains shows the domain as **Active** (deploy.sh added it; add manually if not)
- [ ] Media: R2 → `<client>-media` → Settings → **Custom domain** `media.<domain>` (r2.dev is rate-limited).
      Then re-mirror with the new base URL:
      `R2_PUBLIC_URL=https://media.<domain> python wordpress_export.py --output content.json --media-only`,
      update `R2_PUBLIC_URL` in `worker/wrangler.toml`, commit both.
- [ ] Optional: enable **Images → Transformations** for the zone and set the `IMAGE_RESIZING=cloudflare` variable
- [ ] Old WordPress URLs: the build generates 301s automatically (moved pages, `/wp-content/uploads/…`
      → R2, archives and feeds → /news/, `/?p=123` links). Add anything else to `redirects.csv`
      (copy `redirects.csv.example`), then run the check against the site and fix what it lists:
      `node scripts/check-redirects.mjs --new https://<client>-site.pages.dev --old https://<wordpress site>`
- [ ] SEO: if the old site used Yoast/All in One SEO, the export copied each page's title and
      description (`"seo"` in content.json); check a few. Set `shareImage` in `config/site.json`.
- [ ] Analytics: the export lists the tags it found (`detected.analytics` in content.json). Add the ones
      still in use to `config/site.json` → `analytics` (a Universal Analytics `UA-` ID is dead since
      July 2023; suggest GA4, or Cloudflare Web Analytics, which needs no cookie banner).
- [ ] Switch DNS for the apex/www from the old host to Pages; keep the old host up until verified
- [ ] Search Console: verify the domain (HTML tag → `searchConsole` in `config/site.json`, or DNS),
      submit `https://<domain>/sitemap-index.xml`, and check **Pages → Not found** weekly for a month;
      add any old addresses it reports to `redirects.csv`

## 7. Protect the staff form

- [ ] Zero Trust → Access → Applications → **Add → Self-hosted**, domain `<client>-form.pages.dev`
- [ ] Policy: Allow → Emails → staff addresses (or email domain); session 30 days
- [ ] Open the form in a private window and confirm the login screen appears

## 8. Test end to end

- [ ] Actions tab: **Deploy Worker**, **Deploy Site** / **Rebuild Site** all green
- [ ] `curl https://<worker>/health` → `{"ok":true,"images":true}`
- [ ] Submit a test **event** with an image through the form → success message
- [ ] A commit `content: event "…" via form` appears on `main`; **Rebuild Site** runs
- [ ] Within ~3 minutes the event is on the live site with a square image; check its `srcset`
- [ ] Remove the test entry: edit `content.json`, delete it, commit (the site redeploys)

## 9. Train client staff

- [ ] Walk through one submission of each type together (15 minutes)
- [ ] Explain: rough text is fine (it gets tidied), dates, what the crop preview means, that the site updates in a few minutes
- [ ] Who to contact if the form shows "saved, but not yet published"
- [ ] Bookmark the form URL

## Rollback

Every deploy is tied to a commit, so rolling back is reverting:

- **Bad content or site change:** `git revert <commit> && git push` → the site redeploys the previous state.
  Faster, without a commit: Pages → `<client>-site` → Deployments → pick the last good one → **Rollback**.
- **Bad Worker change:** `git revert` the commit (redeploys), or immediately:
  `cd worker && npx wrangler rollback` (or Workers → Deployments → Rollback in the dashboard).
- **Form submission that published wrong content:** remove or fix the entry in `content.json` and push.
  The KV record (`GET /content/<id>` with the API key) keeps the original submission.
- **Leaked form API key:** generate a new one, `wrangler secret put API_KEY`, update the `FORM_API_KEY`
  secret, redeploy the form (`FORM_API_KEY=<new> bash scripts/deploy.sh` does all three).
