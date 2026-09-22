# WordPress → JAMstack Migration Platform

Moves a client's WordPress site to a static Astro site on Cloudflare Pages. Media lives in R2, and
staff add content through a form → Cloudflare Worker (Claude tidies the text) → commit to
`content.json` → GitHub Actions rebuild. See README.md for the architecture.

## How the scripts are used

### Once per client (setup)

| When | Command | Does |
|---|---|---|
| New client | `bash scripts/deploy.sh` | Creates KV, R2, the Worker + secrets, Pages projects and the staff form; links the domain; writes IDs into `worker/wrangler.toml` (commit it) |
| Migrate WordPress | `python wordpress_export.py --wordpress-url https://<site> --output content.json` | Posts/pages/images → `content.json` + R2 (needs `R2_*` in `.env`) |
| Publish | `git add content.json && git commit && git push` | GitHub builds and deploys the site |

Follow `docs/DEPLOYMENT_CHECKLIST.md` for every new client. New client = new repo from this one via **Use this template**.

### Day to day: nothing to run

Staff submit the form → the Worker structures the text with Claude, resizes the image into R2 and commits to `content.json` → `rebuild.yml` deploys → live in a few minutes.

### Changing the platform

Edit, then `git push`; the workflows redeploy whatever changed:
- `site/` → site (`deploy-site.yml`)
- `worker/` → Worker (`deploy-worker.yml`)
- `config/design-specs.json` → both (aspect ratios, breakpoints, form fields)

Preview locally with `npm run dev` (http://localhost:3000; uses sample data if `content.json` is missing).

### Occasional maintenance

| Situation | Command |
|---|---|
| Bad change | `git revert <commit> && git push`, or **Rollback** in Pages/Workers → Deployments (`cd worker && npx wrangler rollback`) |
| Remove/fix a published entry | Edit `content.json`, commit, push |
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
