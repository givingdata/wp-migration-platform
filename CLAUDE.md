# WordPress → JAMstack Migration Platform

**This repo is the platform template.** Clients don't deploy from it: each client gets its own
private repo (`scripts/new-client.sh <slug>`) that holds that client's settings, secrets and
`content.json`, with this repo as its `upstream` remote. The deploy workflows only run in repos
where `scripts/deploy.sh` has set the `CLOUDFLARE_PAGES_PROJECT` variable.

Moves a client's WordPress site to a static Astro site on Cloudflare Pages. Media lives in R2, and
staff add content through a form → Cloudflare Worker (Claude tidies the text) → commit to
`content.json` → GitHub Actions rebuild. See README.md for the architecture.

## How the scripts are used

### Once per client (setup)

| When | Command | Does |
|---|---|---|
| New client repo | `bash scripts/new-client.sh <slug>` (from the platform folder) | Private `<owner>/<slug>-site` repo + local `../clients/<slug>-site` clone (or `../<slug>-site` if there's no `clients/` folder), `upstream` = platform |
| New client resources | `bash scripts/deploy.sh` (in the client folder) | Creates KV, R2, the Worker + secrets, Pages projects and the staff form; links the domain; writes IDs into `worker/wrangler.toml` (commit it) |
| Migrate WordPress | `python wordpress_export.py --wordpress-url https://<site> --output content.json` | Posts/pages/images → `content.json` + R2 (needs `R2_*` in `.env`) |
| Publish | `git add content.json && git commit && git push` | GitHub builds and deploys the site |

Follow `docs/DEPLOYMENT_CHECKLIST.md` for every new client. On the Mac mini the same steps run from a
settings file with `~/Documents/1WP/ops/provision.mjs` (or the dashboard's **Set up clients** page); see
`docs/ROADMAP.md` for where setup and the admin are heading.

### Day to day: nothing to run

Staff submit the form → the Worker structures the text with Claude, resizes the image into R2 and commits to `content.json` → `rebuild.yml` deploys → live in a few minutes.

### Changing the platform

Make generic fixes in the platform repo and push; then in each client folder run
`git pull upstream main && git push` to roll them out. Client-only changes go straight in the client repo.
In a client repo, pushing redeploys whatever changed:
- `site/` → site (`deploy-site.yml`)
- `worker/` → Worker (`deploy-worker.yml`)
- `config/design-specs.json` → both (aspect ratios, breakpoints, form fields)
- `config/theme.json` → site (preset, colours, fonts, logo; designers follow `docs/DESIGN_HANDOFF.md`)

Preview locally with `npm run dev` (http://localhost:3000; uses sample data if `content.json` is missing).

### Occasional maintenance

| Situation | Command |
|---|---|
| Bad change | `git revert <commit> && git push`, or **Rollback** in Pages/Workers → Deployments (`cd worker && npx wrangler rollback`) |
| Remove/fix a published entry | Edit `content.json`, commit, push |
| Menu or footer changed on WordPress | `python wordpress_export.py --output content.json --site-info-only`, commit, push |
| Images moved to a new domain | `R2_PUBLIC_URL=https://media.<domain> python wordpress_export.py --output content.json --media-only` |
| Rotate the form API key (leak / staff leaving) | `FORM_API_KEY=<new> bash scripts/deploy.sh`, and update the `FORM_API_KEY` GitHub secret |
| Re-import from WordPress before cutover | Re-run the export, commit, push |

### Rarely / never

- `form/mock-worker.mjs`: local testing of form changes (`node form/mock-worker.mjs` + `python3 -m http.server 8080 -d form`)
- `run-all-agents.sh`: obsolete (was for launching build agents); safe to delete

## Gotchas

- Re-running `deploy.sh` without `FORM_API_KEY=<saved key>` generates a **new** key; the form, the Worker and the GitHub secret must all match.
- GitHub secrets can't start with `GITHUB_`: the Worker's repo token is the `CONTENT_REPO_TOKEN` secret and the form key is `FORM_API_KEY`.
- The site's `/cdn-cgi/image` resizing only works on a custom domain with Image Transformations enabled; keep the `IMAGE_RESIZING` variable unset on `*.pages.dev`.
- CI builds fail on purpose if `content.json` is missing (so sample data never ships).
- The staff form's API key is visible in the browser: keep the form behind Cloudflare Access.
- Tests: `cd worker && npm test`; the site build is `npm run build` from the root (npm workspace). Node 22.12+.
