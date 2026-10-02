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

**Status 2026-09-30:** items 1, 3, 4, 11–15, 21 and 22 are built and live on the demo and
Cinderella (router redeployed with its cron). Tested by hand in #demo: remove + undo, a new phone
number everywhere, a news item from a link. Items 5–9, 10 and 16–20 are open.

Next (planned for 2026-09-25):

1. **Images from Slack (built 2026-09-28; `docs/SLACK.md` → Photos).** A photo posted with a
   message becomes the main photo of an entry, an image on a designed page, or a new entry with
   its photo; Claude sees a small copy to choose the place and write the description; stored and
   resized like staff-form uploads; the Approve card shows it. The router forwards `file_share`
   messages and serves `/files/download` for the client's own channel only; `lib/edit` gained
   `setImage()` (images must be under the site's `R2_PUBLIC_URL`). Needs `files:read` (reinstall).
   Next: photos inside body text, removing a photo, several photos at once (a gallery).
2. **`docs/SLACK.md` additions (done 2026-09-30)** (in "When it doesn't work"):
   - The **Slack desktop app** may not show the bot's thread updates or the finished draft
     while the web app does: press **⌘R** (Ctrl+R on Windows) to refresh, or use
     **Help → Troubleshooting → Clear Cache and Restart**.
   - Requests posted as a **reply in a thread** are ignored by design; post in the channel.
3. **New bot token (done 2026-09-28).** The token pasted into a chat during setup was retired
   when the app was uninstalled and reinstalled as SiteFlo; the new one is on the router
   (`SLACK_BOT_TOKEN`), which holds the only Slack secrets.
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
8. **SEO title and description from Slack (planned 2026-09-29).** Today the bot can't edit an
   entry's `seo` block. Without one, the `<title>` and meta description come from the title and
   Summary (or the start of the body), so ordinary text edits change them as a side effect. With
   one (for example imported from Yoast), text edits don't reach the meta tags, and there's no
   way to change them from Slack. Add `seo.title` and `seo.description` to `update` proposals in
   `worker/src/slack-edits.js`, with length limits (about 60 and 160 characters), before/after on
   the Approve card, and a prompt rule to use them only when staff ask about how the page appears
   in search or when shared. Keep `noindex`, `canonical` and the share image off-limits.
9. **Show a page's images in Slack (planned 2026-09-29).** Today the bot only shows a site image
   on the Approve card of a photo change ("Before"); asking "what photos are on the About page?"
   gets the "what I can do" reply, and its own links don't unfurl. Add a `show` action in
   `worker/src/slack-edits.js` that replies with the page's images as Slack image blocks, each
   with its place (main photo, or section › slot on designed pages) and alt text. Reuse the
   photo flow's index of image places and the Approve card's image blocks (URLs under
   `R2_PUBLIC_URL`). Read-only, so no Approve step; it helps staff see what's there before
   asking for a photo change.
10. **Microsoft Teams bot (option, planned 2026-09-30).** The same edits from Teams, for clients
    who use Microsoft 365. Build only when a client asks. Reused as-is: Claude drafting
    (`slack-edits.js`, `lib/edit`), proposals in KV, Approve → commit, 🟢 Live notices
    (`deploys.js`), visitor numbers, remembered questions and the staff check. New:
    - **Chat-neutral replies.** `slack-flow.js`/`slack.js` return plain cards (text,
      before/after, images, Approve/Cancel) with a Slack renderer (Block Kit) and a Teams
      renderer (Adaptive Cards, updated in place after Approve).
    - **`1wp-teams` router** (or a `/teams` route on `1wp-slack`): an Azure Bot registration
      (free tier) + Microsoft app ID/secret; checks the Bot Framework token on each message,
      replies through the conversation's `serviceUrl` with plain `fetch` (no Microsoft SDK),
      maps the sender's tenant ID → client, and forwards the same signed request the client
      Worker already gets.
    - **Differences:** no reactions (use a typing indicator or edit the reply); in channels the
      bot only hears @mentions unless the manifest asks for channel-message permission (RSC);
      photos posted in channels are stored in SharePoint and need Microsoft Graph permissions
      to download (1:1 chats are simpler); delete-a-request handling needs checking.
    - **Getting the bot to clients (the hard part).** Clients have their own Microsoft 365
      organization, and we have no Microsoft 365 org to invite them into as guests. Each
      client's IT admin allows a custom app upload or adds SiteFlo to their org app catalog;
      otherwise list in the Teams Store (Partner Center, publisher verification, Microsoft
      review). Check Microsoft's 2025 changes to bots used across organizations first.
    - **First step when needed:** a test in a trial Microsoft 365 org: bot registration →
      message in → Adaptive Card with Approve → edit committed.

More things staff could change from Slack (ideas 2026-09-30, cheapest first):

11. **Remove and undo (built 2026-09-30; `docs/SLACK.md` → Removing and undoing).** "Take down
    the Spring Gala event" → a Remove card; on Approve the entry moves to `trash.json`
    (`lib/edit` `remove()`), and its dropdown menu links go with it. "Put back the gala post"
    restores it. "Undo that" / "undo the price change" reverses a recent Slack change: a text
    change goes back to its before values, a new entry is removed, a removal is restored. Every
    one still needs Approve. The homepage, designed pages and pages in the main menu bar can't be
    removed (the Edit module refuses them). Tested in #demo 2026-09-30 (remove, then undo).
12. **Links in dropdown menus (built 2026-09-30; `docs/SLACK.md` → Menu links).** "Add the
    Volunteer page under About": Claude returns each changed dropdown's full link list, checked
    against the site's pages (or an outside link staff gave), shown before → after, saved with
    `saveMenu()` (version check; the locked menu bar is enforced there too). Undo works.
13. **Site-wide find and replace (built 2026-09-30; `docs/SLACK.md` → Everywhere at once).**
    Claude gives search terms → `lib/edit` `search()` → Claude writes exact find → replace pairs
    from the snippets → one card with every place → `updateMany()` saves them in one commit
    (all-or-nothing version checks). Max 40 pages. Undo works. Tested in #demo 2026-09-30 (a new
    phone number).
14. **Turn pasted text and links into posts (built 2026-09-30; `docs/SLACK.md` → From pasted
    text or a link).** Pasted text already worked through create; now the first link in a
    request to add something is read (`worker/src/linked-page.js`) and Claude writes a short
    entry from it in its own words, linking back. Tested in #demo 2026-09-30. Two fixes after the
    test: the first step now knows links can be read (it refused before), and cards for new
    entries carry a fixed "📷 post a photo" tip instead of Claude's own (wrong) remark about
    photos. Not yet: Slack's "forward email to channel" files, and the linked page's image.
15. **Scheduling (built 2026-09-30; `docs/SLACK.md` → Later).** Claude sets a local `when`
    (site `TIMEZONE`); Approve schedules (KV `slack:scheduled`), with Cancel; the **router's**
    single cron (every 10 min) sends each client a signed tick, and due changes go through the
    usual `applyProposal`. One cron for all clients because the free plan allows only 5 Cron
    Triggers per account. Router redeployed 2026-09-30; a tick was checked in its logs with no
    client errors. Photos can't be scheduled yet.
16. **Preview link on the Approve card.** Build the proposed change on a preview branch (as sales
    previews do) so staff see the real page before approving.
17. **Section changes on designed pages.** Hide, show or reorder sections ("move the
    testimonials above the menu"), limited to the design's existing section types. Today the
    prompt forbids it.
18. **Documents.** PDF uploads (menus, newsletters, annual reports, board minutes) stored in R2
    and linked from a page; same path as photos (`files:read`, size/type checks, Approve card).
19. **More photo work.** Photos inside body text, galleries, and removing a photo (noted as "not
    yet" when photos shipped).
20. **Key facts.** A safe subset of site settings: hours (incl. holiday hours), phone, address,
    social links. Among the most common small-business requests; needs those facts to live in
    one place in content, not repeated in page text.
21. **Redirects (built 2026-09-30; `docs/SLACK.md` → Redirects).** Removing an entry records its
    address and a destination (its listing, or the page staff name) in `trash.json`; staff can
    also redirect any old address (`content.json` → `redirects`, `addRedirect()`/
    `removeRedirect()`). `site/redirects.mjs` writes both after `redirects.csv`, never for a served
    address. Renames never change slugs, so they need nothing. A full WordPress re-import keeps
    staff redirects.
22. **Content health check (built 2026-09-30; `docs/SLACK.md` → "Anything out of date?").**
    `worker/src/health.js` over `lib/edit` `readAll()`: stale news, no upcoming events, last
    year's dates on pages, placeholder text, missing internal pages (grouped per page), dead
    outside links (random 15 per run: free-plan 50-subrequest limit), missing image
    descriptions. Report written in code, not by Claude. Tried on Cinderella's content: found
    real dead links (a Google Form, expired event pages), homepage photos without descriptions,
    2024/2025 mentions, and old NextGEN gallery links. Stage 3 (2026-10-02): photos without
    descriptions inside page text, missing summaries, repeated or long search titles, long
    search descriptions; each group ends with what to ask for. Monthly check-up
    (`worker/src/checkup.js`): first weekday of the month, 10:00–17:00 site time, on the
    router's tick, once per month (KV marker), only with findings, no outside links;
    `SLACK_CHECKUP = "off"` turns it off.

Follow-ups from building 11–22:

- **Rolling platform changes out** to client repos is a merge (they have their own commits):
  `git pull --no-rebase --no-edit upstream main && git push`. With more clients this wants a
  script (or the dashboard) that merges, runs the `worker` tests and pushes each one; see
  "Content-only client repos" above for the longer-term fix.
- **Time-zone data differs between Node versions** (B.C.'s permanent daylight time is in newer
  data): tests must check against the runtime's own rules, never a hard-coded offset.
- **Schedule photos**, and the **linked page's image** as the entry's photo (licence permitting).

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

**Define each section type once (do alongside the template work, since it adds section types).**
Each type is described in two places today: `site/src/lib/sections.ts` (field types and build
checks) and `lib/edit/sections.js` (which slots staff can edit through the form and Slack).
Headless WordPress would add a third (block definitions). Move to one definition per type
(fields, which are editable, labels) that generates or drives all of them. Rules for new types:

- **Flat, simple fields:** text, image, buttons, lists of items. They map cleanly to WordPress
  block attributes and ACF/Pods fields; avoid deep nesting.
- **Formatted text policy:** section text is plain today, but WordPress text arrives with bold,
  links and so on. Pick one rule (e.g. allow basic inline formatting, strip the rest).
- **Namespaced names outside the platform:** `siteflo/hero`, so our quote section never clashes
  with WordPress's `core/quote`.

## Uptime monitoring (planned 2026-09-29)

Cloudflare's own uptime checks (Health Checks, Load Balancing monitors) need a paid plan on
each domain, so build a small monitor instead:

1. **A Worker on a Cron Trigger (free), every 5 minutes**, checks each client's site, staff
   form and Worker, and posts to Slack #siteflo when something fails and again when it
   recovers (no repeat alerts while it stays down).
2. **Check for the likely problems, not only downtime:**
   - the page answers 200 and contains an expected marker (the site name or a footer string),
     which catches a broken deploy that still serves a page;
   - the staff form still redirects to the Cloudflare Access login (a 200 means the lock is off);
   - SSL certificate and domain registration expiry, warned 14 days ahead.
3. **Client list from ops** (`ops/clients/<slug>.json`), so new clients are covered
   automatically; later from the central admin (Phase 3).
4. **Outside check for Cloudflare-wide outages:** a Worker can't report that Cloudflare itself
   is down, so add a free external monitor (e.g. UptimeRobot, 50 monitors at 5-minute checks)
   on flomysite.com and a few key client sites.

Real downtime on Pages is rare; a bad deploy, a lock that came off, or an expired domain is the
more realistic risk, which is why the checks look at content and settings as well as status.

## Headless WordPress (planned 2026-10-02; option for Complex-tier sites)

For clients who need to keep WordPress (staff familiarity, large structured content, an RFP
that asks for it), WordPress stays the editor and source of truth, and the platform builds and
serves the public site. First candidate: the Vancouver Writers Fest RFP, which accepts
headless if it meets their requirements. Default clients stay on the JSON + Slack setup.

1. **WordPress moves to a private address** (`cms.<domain>`) behind Cloudflare Access; only
   staff reach wp-admin. Its host stays the client's (VWF: DreamHost) or moves to a cheap one.
2. **Publish → rebuild:** a small must-use plugin calls GitHub `repository_dispatch` on
   `transition_post_status` (covers scheduled posts going live), and the build pulls content
   from the REST API. `wordpress_export.py` already does the reading; it needs custom post
   types, custom fields (ACF/Pods, which must be set to show in the API), taxonomy terms and
   links between records.
3. **WordPress store for the Edit module:** writes through the REST API with an application
   password, so Slack edits and the staff form land in WordPress, not `content.json`, and
   there's one source of truth.
4. **Carries over from WordPress:** Yoast data (`yoast_head_json`), Redirection rules (read at
   build into `_redirects`), scheduling, users and roles. **Doesn't:** page builders, form
   plugins and calendar or shortcode views, which the platform replaces.
5. **Also needed:** a "Preview on site" route for drafts (authenticated), styles for WordPress
   core blocks in each theme preset, and the cookie consent banner (Slack section, item 5).
   VWF also needs Meta Pixel behind consent.
6. **Related platform work this would bring forward:** linked records (an event lists its
   authors and venue; an author page lists their events), Pagefind search with filters,
   and credit/licence fields on media.
7. **WordPress blocks rendered by our components.** Map each block name to a platform
   component with a lookup table (`core/image` → Image, `core/quote` → Quote,
   `core/buttons` → Buttons…), falling back to the block's own HTML for blocks we don't map,
   so pages written in wp-admin take on the theme preset instead of looking like a WordPress
   theme. The standard REST API only returns finished HTML, so this needs the parsed block
   list: WPGraphQL with a blocks add-on, or a small plugin of our own exposing
   `parse_blocks()` output. Check which is practical before the first headless build.
   Same pattern as `components/sections/Sections.astro`; when that file next grows, move it
   from its ternary chain to a typed lookup map (keeps the per-type prop checks) so both use one
   approach.
8. **Sections stay sections; core blocks don't become them.** Sections are whole page bands
   with fixed slots; core blocks are small, freely nested pieces. Only a few look alike (cover
   ≈ hero, media & text ≈ split), so converting core blocks into sections would be fragile.
   Core blocks (item 7) style body content only. For designed pages edited in wp-admin,
   register our section types as **custom blocks** (`siteflo/hero`, `siteflo/stats`…) with the
   same fields, generated from the single section definitions (Template designs above), and
   rendered by the same components. One vocabulary, two editors: form/Slack for standard
   clients, WordPress for headless ones. Only needed when a headless client wants to build
   designed pages themselves; a first headless client (VWF) can keep its homepage and landing
   pages as sections we manage while staff use WordPress for events, authors and news.

Later, for clients who want an admin screen without WordPress: a git-based CMS (Keystatic,
TinaCMS or Sveltia) that edits the same JSON files, so the Edit module, Slack and the build keep
working unchanged.

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
