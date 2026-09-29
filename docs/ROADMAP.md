# Platform roadmap: scaling to many clients

Decided 2026-09-23. The platform runs one client today (The Cinderella Project); these are
the steps for growing without rebuilding what exists.

## Principle: split keys by what they can do

| | Setup keys | Running keys |
|---|---|---|
| Used for | Creating repos, Workers, buckets, Pages projects, Access apps | Committing content, storing media for one client |
| Power | Account-wide | One client only |
| Lives | Off anything a client can log into (Mac mini now, an approval-gated ops runner later) | Cloudflare, next to the code that uses it |

## Phase 1: setup on the Mac mini (in progress)

- Each client has a settings file (`~/Documents/1WP/ops/clients/<slug>.json`).
- `ops/provision.mjs` runs `scripts/new-client.sh` and `scripts/deploy.sh` from it,
  step by step, and is safe to re-run. The dashboard's **Set up clients** page runs it
  (operator only, over Tailscale).
- Manual steps for now: adding the repo to the content GitHub token, and the Cloudflare
  Access app for the staff form.

## Phase 2: setup in a private ops repo

- `ops` becomes a private GitHub repo; a workflow runs `provision.mjs` with the setup
  keys stored as that repo's secrets, behind a required approval.
- The dashboard (or the central admin) can only *request* a new client.
- Deploys move to the ops repo too, so client repos no longer hold the account-wide
  Cloudflare token (today every client repo's Actions can edit every client's resources).
- Automate the manual steps: Access apps via the Cloudflare API, repo access via a GitHub App.

## Phase 3: central admin for clients

- One admin app on Cloudflare (Worker + Pages) for every client: Create, Edit,
  Submissions, Media, History. Login with Cloudflare Access; a D1 table maps each user to
  their client(s); every request is scoped to the logged-in client; an operator role sees all.
- Commits through a **GitHub App** installed only on client repos (short-lived, per-repo
  tokens; no personal token in the cloud).
- The Mac dashboard becomes the operator view of the same app.
- Build features as self-contained modules that take a repo + token (e.g. the Edit
  module: list, load, save with a conflict check), so they run on the Mac dashboard now
  and in the central admin later.

## Also needed as clients grow

1. **Content-only client repos.** Today each client repo is a full copy of the platform,
   updated with `git pull upstream main`. At scale, client repos should hold content and
   settings only, with the site code coming from the platform (a shared GitHub workflow
   or package), so a platform fix reaches every client without per-repo merges.
2. **Split `content.json`.** One file per site means whole-file rewrites and conflicting
   edits. Move to one file per entry (or content in D1) before editing becomes frequent.
3. **Cloudflare account limits.** Each client uses a Worker, a KV namespace, an R2 bucket
   and two Pages projects; the Pages project limit (about 100 per account unless raised)
   is reached first. The central admin removes one Pages project and the Worker per client.
4. **Generic content types (done 2026-09-24; `docs/CONTENT_TYPES.md`).** The form, Worker and
   site used to offer the first client's types (Exhibition, Event, Post). Now each client's types
   come from `config/design-specs.json`, defaulting to News, Event and Announcement, with
   Exhibition opt-in. The original plan:
   - Define each client's types in `config/design-specs.json` (label, fields, image shape,
     listing page, whether it shows on the homepage), so the form, the Worker and the site
     all read the same list and a client can add or hide types without code changes.
   - Ship a generic default set, for example **News**, **Event** and **Announcement**
     (short notice, optional homepage banner), with **Exhibition** as an opt-in type for
     arts clients. Other candidates: photo gallery, team member, job posting, sponsor.
   - Allow **updating an existing page**, not only adding new entries. This uses the Edit
     module (see "Claude edits the site" below).
   - Keep existing `content.json` entries working: types that exist today keep their
     paths, so no client's links change.
   Touches: `config/design-specs.json`, `form/` (labels and fields), `worker/src/claude.js`
   (prompt per type), `worker/src/github.js`, `site/src/lib/content.ts`, the
   `exhibitions`/`events` pages and layouts, and the export's type mapping.
5. **Minimum TLS 1.2 on every domain.** Cloudflare zones default to accepting TLS 1.0 and
   1.1, which are outdated. Set **SSL/TLS → Edge Certificates → Minimum TLS Version → TLS 1.2**
   on flomysite.com (the SiteFlo site; still accepts 1.0 as of 2026-09-28) and on each client
   domain when it moves to the platform. Add it to `docs/DEPLOYMENT_CHECKLIST.md` (go-live
   step), or set it from `ops/provision.mjs` once its token can edit zone settings.

## Edit module (built 2026-09-24)

`lib/edit/` (see its README): list, get, create, update with a version check, delete to
`trash.json` and restore. The staff form's **Edit existing** mode uses it through the Worker.
Storage is a pluggable **store** (GitHub `content.json` today), which is the connector point for
a future lightweight content platform or database: a new store implements `read`/`write`, and
the form, dashboard and Claude routes below keep working. Still to do: a dashboard Edit page
(can reuse the Worker routes), per-entry history ("restore an earlier version") from git.

## Slack edits (built 2026-09-24; `docs/SLACK.md`)

Staff post a request in their client's Slack channel, Claude drafts the change, and Approve
commits it through the Edit module. Tested on Cinderella: edit a page's text, add a news item,
remove a line. Progress shows as 👀 on the request and a thread message that updates as it works.

**Shared app (built 2026-09-25):** all clients now go in one free Slack workspace (FloMySite.com)
as regular members, one private channel per client, served by one SiteFlo app through the
`slack-router/` Worker (1wp-slack). Adding a client is `scripts/slack-add-client.mjs`; the only
manual step is inviting their staff to the workspace. Cinderella moves from its own app setup to the
router as the first client (that move also gives it a new bot token, item 3 below).

Next (planned for 2026-09-25):

1. **Images from Slack (built 2026-09-28; `docs/SLACK.md` → Photos).** A photo posted with a
   message becomes the main photo of an entry, an image on a designed page, or a new entry with
   its photo; Claude sees a small copy to choose the place and write the description; stored and
   resized like staff-form uploads; the Approve card shows it. The router forwards `file_share`
   messages and serves `/files/download` for the client's own channel only; `lib/edit` gained
   `setImage()` (images must be under the site's `R2_PUBLIC_URL`). Needs `files:read` (reinstall).
   Next: photos inside body text, removing a photo, several photos at once (a gallery).
2. **`docs/SLACK.md` additions** (in "When it doesn't work"):
   - The **Slack desktop app** may not show the bot's thread updates or the finished draft
     while the web app does: press **⌘R** (Ctrl+R on Windows) to refresh, or use
     **Help → Troubleshooting → Clear Cache and Restart**.
   - Requests posted as a **reply in a thread** are ignored by design; post in the channel.
3. **New bot token for Cinderella** before real staff use it: the current one was pasted into
   a chat during setup. Reinstalling keeps the same token, so get a new one and update the
   Worker secret `SLACK_BOT_TOKEN`.
4. **Visitor numbers in Slack (built 2026-09-29; `worker/src/analytics.js`).** Staff ask "how many
   visits this month?" and Claude answers from the numbers only. Sources: `cloudflare` (Web
   Analytics, cookieless; needs a read-only Account Analytics key; no backfill) and `sample`
   (labelled made-up numbers, used on the demo). Next: test the Cloudflare source on live data
   (flomysite.com), then turn it on per client at go-live.
5. **Option: Google Analytics (GA4) as a source.** For clients who already use GA4 or want its
   reports. The site can already load the GA4 tag (`analytics` in `config/site.json`); this adds:
   - A `ga4` source in `analytics.js` using the GA4 Data API (`runReport`: sessions, page views,
     top pages, traffic sources, countries, devices), mapped to the same shape, so the Slack
     answers don't change.
   - Access through a Google Cloud service account given **Viewer** on the client's GA4
     property: `GA4_PROPERTY_ID` var and a `GA4_SERVICE_ACCOUNT` secret (the Worker signs its
     own token with Web Crypto; no Google SDK). One service account for all clients.
   - **Cookie consent.** GA sets cookies, so sites using it need a consent banner (Quebec's
     Law 25, GDPR for EU visitors) with GA's consent mode; Cloudflare Web Analytics doesn't.
     Build the banner into the platform, shown only when a cookie-setting provider is on.
   - Note for clients: GA and Cloudflare count differently (GA sessions vs Cloudflare visits,
     and ad blockers stop GA more often), so their numbers won't match exactly.
6. **Welcome message for new clients (planned 2026-09-29).** Today nothing tells staff how to use
   the bot when they join their channel. When `slack-add-client.mjs` creates a channel, the router
   posts and pins a short welcome: what they can ask for (text changes, news items, photos, visitor
   numbers), that a person clicks Approve before anything goes live, that changes go live within
   minutes, what the bot won't do (deletes, menu, settings: use the staff form), and to post in the
   channel rather than in a thread. Skip it on re-runs so it isn't posted twice.
7. **Time zone in setup (planned 2026-09-29).** Visitor numbers need the `TIMEZONE` Worker
   variable (for example `America/Vancouver`), or days are counted in UTC. `ops/provision.mjs` and
   the dashboard's **Set up clients** page don't set it yet: add a time zone field (default from
   the client's location) and write it into `worker/wrangler.toml`.

## Sales previews (built 2026-09-25 to 09-28; `ops/preview.mjs`)

From a WordPress scan in the assessment tool, **Build preview** asks the dashboard on the Mac mini
to copy 1–3 pages onto this platform and publish them at a private address on the
`siteflo-previews` Pages project (noindex, kept 30 days). The build copies the site code, exports
with `wordpress_export.py --pages`, applies a theme preset plus the prospect's brand
(`ops/lib/brand.mjs`: logo, main colour, free fonts; photos shaded neutral with the optional
`overlay` colour), and has Claude draft the homepage sections (`scripts/draft-sections.mjs`).

Next:

1. **Record each preview's Claude cost.** The homepage draft is the only Claude call (Claude
   Opus 5, high effort; estimated $0.10–0.30 per preview, mostly output and thinking tokens).
   `draft-sections.mjs` already prints its token counts; `preview.mjs` should read them into the
   preview's record (`usage: { input, output, model, cost }`), priced from a small rate table
   kept next to it. The assessor's preview card then shows "Claude: $0.14", and
   `preview.mjs list` a running total, to confirm the estimate and decide whether previews stay
   free for prospects.
2. **Expiry cleanup and a "Preview by Siteflo" banner.** Delete branch deployments past
   `expiresAt` (a scheduled `preview.mjs cleanup`), and mark every preview page as a preview.
3. **Non-WordPress sites.** Previews work only where `/wp-json` answers; Wix, Squarespace and
   others need their own scrapers.
4. **Dashboard auto-start.** The dashboard runs by hand (`nohup`); a LaunchAgent would restart
   it after a reboot, so the assessor's Build preview doesn't fail with "Can't reach the
   dashboard".

## Template designs (planned 2026-09-29)

flomysite.com now says the prices cover "a new site built from a SiteFlo template design, styled
with your logo and brand colours", with custom design sold separately. Today that template is
one look: sales previews use the `modern` preset plus the prospect's brand, and only the homepage
gets the banded sections (hero, split, cards, stats, stories, call to action with light / alt /
band tones) that were first built for Cinderella's Roots design. The café demo (`bistro` preset,
FoodZero design, menu/features/tiles sections) shows how much better a complete design looks.
Goal: a small set of better templates.

How to choose them:

1. **Start from client types, not design galleries.** Pick 3–4 from real prospects (e.g.
   charity/nonprofit, hospitality, professional services, arts/community). Each needs a
   different homepage: impact stats + donate + stories; photos + menu + hours; services + proof
   + contact. Start with three, not ten.
2. **A template is three things:** a theme preset (fonts, colour roles, buttons, spacing), a
   homepage recipe (which sections, in what order, which tones), and inner page layouts (About,
   Services, News, Contact). Previews look plain mainly because only the first two change.
3. **Selection criteria:**
   - survives a brand swap: one accent colour on neutral backgrounds, not a palette or gradient
     the design depends on;
   - fits real WordPress content: long text, few good photos (photo-led designs only for client
     types that have photos, like hospitality);
   - maps onto the existing section types, needing at most one or two new ones;
   - stays readable with any client colour (pale or yellow brand colours still give readable text
     and buttons);
   - works on phones, with no carousels, heavy animation or unusual grids.
4. **Sourcing.** Bought Figma templates are fastest, but check the licence: many marketplace
   licences cover one end product, which doesn't allow reuse across client sites. Figma
   Community files are often CC BY (credit required), usually fine. Or commission a designer to
   produce a set to `docs/DESIGN_HANDOFF.md`, and own them outright.
5. **Test before committing.** Build previews of three real prospect sites from past assessor
   scans with each candidate preset (`preview.mjs build <url> --preset <name>`); keep the ones
   that still look good with real brands and content.
6. **Later: the assessor recommends a template** for the prospect's type of site and builds the
   preview in it.

Possible first step: summarise past assessor scans by client type to decide which three
templates to find first.

## Future option: Claude edits the site

Part of the original spec (staff update the site with Claude's help). Today Claude only
tidies *new* form submissions in the Worker; this adds Claude changing *existing* content.
Not scheduled yet. All three routes sit on the same **Edit module** (list, load, save with a
conflict check, every save a commit):

1. **Claude connector (MCP server).** Site content as tools (`list_pages`, `get_page`,
   `search_content`, `update_page`, `create_post`, `preview_change`, `publish`) for
   claude.ai, Claude Desktop, the Claude mobile app and Claude Code.
   - Operator first: a local connector on the Mac mini (no hosting, no new keys).
   - Clients later: the same tools hosted on Cloudflare Workers, login through Cloudflare
     Access, each user's tools scoped to their own site (Phase 3).
2. **"Ask Claude" in the dashboard / staff form.** A plain-language request → Claude
   proposes a change with the edit tools → before/after view → Publish or Discard.
3. **`@claude` on GitHub.** Claude Code's GitHub Action opens a pull request from an issue
   comment. Nearly free to set up; suits the operator more than client staff.

Rules for every route: changes go through the Edit module (validated, committed,
revertable); a person approves before publishing; users reach only their own client;
Claude can't delete pages or touch site code or settings.

Suggested order: (1) Edit module + dashboard Edit page → (2) local connector for the
operator → (3) "Ask Claude" with before/after review → (4) hosted connector and in-form
assistant for clients, alongside the Phase 3 central admin. Splitting `content.json` into
one file per entry makes Claude's edits smaller and conflict-free; the Edit module hides
the storage format, so it can start on `content.json` and switch later.
