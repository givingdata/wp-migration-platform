# Slack: staff ask for edits in a channel

Optional. Staff post a request in their Slack channel, for example *"change the Contact page hours
to 9–5"*. The **SiteFlo** bot puts 👀 on the message and answers in a thread ("Working on it…", then
what it's doing), which can take up to a minute for a new article. It ends with a before/after of
the change and two buttons, **Approve** and **Cancel**, and the 👀 goes away. Only an approved
change is saved to `content.json` (one commit, through the same Edit module as the staff form) and
the site updates a few minutes later. The message then says *"Going live in a few minutes…"*, and
changes to **🟢 Live on the site** once the deploy finishes (or ⚠️ if the build failed). The site
workflow reports each deploy to the Worker (`POST /deploy/notify`, signed with GitHub's own OIDC
token, so there's no secret to set up; it needs the repo's `WORKER_URL` variable).

If the request is unclear, the bot asks a question instead. Answer it in the thread, or post the
answer as your next message in the channel within 10 minutes; the bot remembers what you asked
for and drafts the change. Other replies in threads are ignored, so staff can talk there freely.

Designed pages (built from `sections.json`, like the homepage) work too: the bot changes the words
and links inside their sections and saves them to `sections.json`, with the same before/after and
Approve. It never adds, removes or moves sections.

**Photos.** Post a photo (JPG, PNG or WebP, up to 10 MB) with a message saying where it goes:
*"Use this for the Grad Night event"*, *"Put this in the homepage banner"*, or *"New event: Grad
Night, June 5… "* with the photo. Claude looks at a small copy of it, picks the place (the main
photo of a news item, event or other entry that shows one, an image on a designed page, or a new
entry) and writes the image description for screen readers. The photo is stored and resized like a
staff-form upload, and the Approve card shows it (before and after). Post a photo without a message
and the bot asks where it goes; answer in the thread, no need to post the photo again. One photo
per message. Not yet: putting new photos inside a page's text, and removing photos. Needs the `files:read`
scope (see below).

**Photo descriptions.** *"Describe the photos on the About page"* or *"fix missing photo
descriptions"* (no page: the one with the most goes first): the bot finds photos with no
description (`<img>` in the body text with no or empty `alt`, a main photo without `imageAlt`, a
designed page's image whose description is empty), downloads up to 10 (shrunk for Claude; ones it
can't open are left out and counted), and Claude describes them from what it sees plus the page
title and nearby text (one sentence under 150 characters, no names of people). One card shows each
photo numbered with its description and says how many are left on that page and how many other
pages need them. Before Approve, a reply in the card's thread changes it: *"#3: Volunteers sorting
donations"* or *"skip #3"*; the card updates in place. Approve is an ordinary update (only the
`alt` of those tags changes; other attributes stay as they were), so undo works. Code:
`worker/src/photo-descriptions.js`.

**Removing and undoing.** *"Take down the Spring Gala event"* gives a **Remove** card (red
button). On Approve the entry comes off the site and goes to `trash.json` with who removed it and
why; its links inside dropdown menus go with it. *"Put the gala back"* shows what's in the trash
and restores it where it was. *"Undo that"* (or *"undo the price change"*) reverses one of the
changes made in Slack in the last 30 days: text and photos go back to what they were, a new entry
is removed, a removal is put back. Each of these is a new card that needs **Approve**. Undo refuses
if the entry was changed again since (tell the bot what it should say now instead), and can't
remove a photo that wasn't there before. The homepage, designed pages and pages linked from the
main menu bar can't be removed.

**"Anything out of date?"** The bot checks the whole site (`worker/src/health.js`, read-only,
one read of the content) and replies with what could use a look, each with a link to the page:
the newest news item over 90 days old, no upcoming events, pages that mention last year or the
year before, placeholder text (lorem ipsum, "coming soon", TBD), links to pages that don't exist
(one line per page; old WordPress addresses the site redirects don't count), outside links that
answer 404/410 or can't be reached, photos without a description (the main photo, designed
sections' photos and photos inside the text, counted per page), pages with no summary (Google then
picks the text itself), search descriptions over ~155 characters, and search titles that several
pages share or that run over ~60 characters. Search titles and descriptions are worked out the way
the site renders them (`seo.title`, else "Title | `SITE_NAME`"; `seo.description`, else the
summary); long automatic titles and missing summaries count for pages only, not news or events;
noindex pages are skipped. Outside links are a random 15 per check (a Worker gets 50 outgoing
requests per run on the free plan), so asking again checks others. Long lists stop at 8 with
"…and N more", and each group ends with what to ask for ("describe the photos on About", "how
does About look on Google?"). The findings come from the content, not from Claude; staff then ask
for fixes as usual. The report says "photo descriptions", "search title" and "search
description", never SEO, meta or alt text.

**Monthly check-up.** On the first weekday of each month, between 10:00 and 17:00 in the site's
`TIMEZONE`, the bot posts a short summary of the same check in the site's channel (the first of
`SLACK_CHANNEL_IDS`): how many things could use a look, a line per group with the first three
pages, and an invitation to ask "is anything out of date?" for the full list. Nothing is posted
when the check finds fewer than three things. Outside links are left out (they're slow; asking the bot checks
them). It runs on the router's 10-minute tick (`worker/src/checkup.js`), and a KV marker per month
(`slack:checkup:YYYY-MM`) makes it post once; a check that fails is tried again on the next tick.
On by default; `SLACK_CHECKUP = "off"` in the client's `worker/wrangler.toml` turns it off. Router
mode only.

**How it looks on Google.** *"How does the About page look on Google?"* (or *"search preview for
the homepage"*) replies with a mock search result (`worker/src/search-preview.js`, read-only): the
title and description exactly as the site renders them (`lib/edit` `searchPages()`, which follows
`BaseLayout.astro`), the address, where each comes from when the page has no search title or
description of its own (title + site name; its summary, the start of its text, or the site's
tagline), and its share image. Warnings in plain words: a title over ~60 or a description over
~155 characters (likely cut off), a missing or short description, and a title or description
another page also uses. *"Make the search description for About mention free prom dresses"* is an
ordinary change (Approve, undo); the drafting prompt only touches the search title/description
when the request is about Google, search or shared links. They're stored in the entry's (or
designed page's) `seo` object; a search title is used exactly as written. Post a photo with
*"use this as the share image for the Events page"* to set the picture shown when someone shares
a link (`seo.image`, cropped to 1.91:1). The homepage's tagline fallback is only shown if the
Worker has `SITE_TAGLINE` (Deploy Worker copies the GitHub variable `SITE_TAGLINE` into it);
otherwise the preview says "your site's tagline". Staff never see the words SEO or meta.

**Redirects.** When something is removed, its old address sends visitors to its listing page
(`/news/`, `/events/`…, or the homepage for pages) instead of "page not found", or to the page
staff name (*"take down the gala and send people to the events page"*). The address and where it
goes are kept with the entry in `trash.json`, so putting it back ends the redirect. Staff can also
send any old address somewhere (*"our flyer says /summer-camp, send it to the camps page"*); these
are kept in `content.json` → `redirects`. Both go into `_redirects` at build time, after
`redirects.csv` (which always wins), and never for an address the site serves. Renaming a page
never changes its address, so renames need no redirect. Undo works.

**Menu links.** *"Add the Volunteer page under About"*, *"rename Contact us to Get in touch"* or
*"move Team to the top of the About dropdown"* changes the links inside the navigation menu's
dropdowns, with each changed dropdown's links shown before → after on the Approve card. The menu
bar itself (its top-level items) stays as designed unless `design-specs.json` has
`"menu": { "topLevel": "editable" }`, in which case a top-level item can get a new dropdown; the
bar's items are never added, renamed or moved from Slack. Links go to pages that exist, or to an
outside address the staff member gives. Undo works here too.

**From pasted text or a link.** Paste an email or newsletter with *"post this as news"* and the
bot writes the entry from it. With a link (*"add this as news: https://paper.example/story"*,
or an event page), the Worker reads that page (`worker/src/linked-page.js`: HTML only, 8-second
timeout, title/description/main text, capped) and Claude writes a short entry in its own words
with a link back (in the Link field when the type has one, otherwise "Read more" at the end).
If the page can't be read, it uses only what the message says. The page is data for Claude,
never instructions.

**Later.** Add a time to any request: *"post this on Friday at 9"*, *"take the gala down after
the 15th"*, *"change the hours on Monday"*. The card says when (⏰) and the button reads
**Approve for Mon 5 Oct, 9:00 a.m.** Approving schedules it: the message says when it will
happen and keeps a **Cancel it** button. The shared router's cron ticks each client every
10 minutes, so it goes live within about 10 minutes of the time, plus the usual build. Times
are in the site's `TIMEZONE` (UTC if unset), up to a year ahead. If the page was changed in the
meantime, the scheduled change doesn't go live and the message says why. Needs router mode
(direct-mode Workers have no tick).

**Everywhere at once.** *"Our phone number is now 604-555-0199"* or *"change Executive Director
to CEO everywhere"*: the bot searches every entry and designed page for the current wording
(`lib/edit` `search()`), Claude writes exact replacements from the matching snippets (including
`tel:`/`mailto:` links), and one card shows each place before → after. Approve saves them all in
one commit (`updateMany()`); if any of those pages changed in the meantime, nothing is saved.
Up to 40 pages at a time; very short replacements (under 3 characters) are refused. Undo works.

What it does **not** do:

- No permanent deletes, no menu bar changes, no settings. Those stay in the staff form.
- Nothing is published until someone presses **Approve**.
- It only reads and answers in the channels you list, and only for the staff you list. Everyone
  else is ignored.

All clients share **one** Slack app (SiteFlo) in the FloMySite.com workspace (free plan). Each client's
staff are regular members of that workspace, in a private channel named after their site. The
shared **1wp-slack** router Worker (`slack-router/`, design in `slack-router/README.md`) receives
every Slack request and forwards each client's to that client's Worker. Clients never install
anything in their own Slack.

## Add a client (shared app)

In the client folder, on the Mac mini (the router's admin key is in `~/Documents/1WP/ops/.env.operator`):

```bash
node ../../platform/scripts/slack-add-client.mjs <client> --domain <their email domain> --push
```

(`--emails a@x.org,b@x.org` for individual people instead of, or as well as, a domain.) This:

1. Creates the private channel `#<client>` with the bot in it, and adds you (the router's
   `SUPPORT_EMAILS`) and any staff who are already in the workspace.
2. Sets the client repo's `SLACK_ROUTER_KEY` GitHub secret.
3. Fills in the Slack lines in `worker/wrangler.toml`, commits and pushes: **Deploy Worker** runs.

**Then you:** invite their staff to the workspace (Slack → the workspace name → **Invite people**,
their work emails). Slack has no invite API on the free plan. When each person joins, the bot adds
them to their channel, if their email is on the client's staff list.

The same command, run again, manages the client:

| Task | Command (in the client folder) |
|---|---|
| Add a person / domain | `… <client> --emails new@x.org --push` (replaces the list; give the whole list) |
| Remove someone from the channel | `… <client> --emails <list without them> --prune --push` (deactivating their Slack account is manual) |
| Pause / resume | `… <client> --pause` / `--resume` |
| New key (leak) | `… <client> --rotate-key --push` |
| Remove the client | `… <client> --remove` (archives the channel; it can be unarchived) |
| List clients | `… --list` |

### The shared app and router (set up once)

- Router: `slack-router/` → `npm install`, `npx wrangler deploy` (with the setup token from
  `ops/.env.operator`). It's at https://1wp-slack.weathered-sun-5146.workers.dev. Its secrets:
  `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` (the app's, set in the Cloudflare dashboard →
  Workers → 1wp-slack → Settings → Variables and Secrets), `ROUTER_SECRET` and `ADMIN_KEY`
  (random; the admin key is also in `ops/.env.operator`).
- Slack app: its settings are `slack-router/manifest.json` (App Manifest page on
  https://api.slack.com/apps → the app). Request URLs point at the router, not a client Worker.
- Logs: `cd slack-router && npx wrangler tail --format pretty`, and the client Worker's own tail.

## Own Slack app per client (direct mode, older setup)

The rest of this page is the older setup, where a client's Worker is its own Slack app's Request URL
(`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN` on that Worker). Use it only for a client that wants the
bot in its own Slack workspace. Its app settings are `slack/manifest.json`.

### Set it up (about 15 minutes)

Run the commands in the **client folder** (e.g. `clients/<client>-site`). You need the Worker URL
(the `WORKER_URL` variable that `deploy.sh` set, or the `https://….workers.dev` address it printed).

Before you start:

- **Don't use the Slack CLI** (`slack` command) for this app. It's for apps that run on Slack's own
  hosting, and it quietly changes the app's settings: it turns on Socket Mode (Slack then stops
  calling the Worker), replaces the permissions, and clears the button address. If it was used,
  go through **Check the app's settings** below.
- The app's settings are only on the **website** (https://api.slack.com/apps), in a browser signed
  in to the workspace. The Slack desktop app only shows the bot's profile.
- Links that open on the Mac mini (`--open`, `pbcopy`) don't reach another computer. Copy the
  printed link instead.
- Paste keys only into the `gh secret set` prompt (step 3), never into a chat or a file.

### 1. Create the Slack app from the link

```bash
node scripts/slack-app-link.mjs --open
```

This fills the Worker URL into `slack/manifest.json` and opens Slack's "create app" page with
everything already set (name, permissions, events, buttons), and copies the link to the clipboard.
If the Worker URL isn't found, add it: `--worker-url https://<client>-worker.<account>.workers.dev`.

In the page: pick the workspace → **Next** → **Create**. The app belongs to that workspace for
good, so check it before you click **Create** (a wrong one means deleting the app and starting
again). Slack may say the request URL isn't verified yet; that's expected (the Worker doesn't have
the Slack secret yet). Step 5 fixes it.

If the page opens empty (no name or permissions filled in, which can happen after a sign-in), wait a
moment or reload. If it's still empty: choose **From a manifest** → the workspace → the **JSON** tab,
replace everything with the contents of `slack/manifest.json`, change each `https://WORKER_URL` to
the Worker URL, then **Next** → **Create**. Create the app only once; every open of the link starts
another one.

Your new app's page has an address like `https://api.slack.com/apps/A0123ABCD/general`. The
`A0123ABCD` part is the **app ID**; the links below use it. All your apps: https://api.slack.com/apps
(the app menu can list the same app twice; same ID, same app).

The bot's name in Slack is the app's name (**SiteFlo** unless you changed it while creating it). Use that
name wherever this guide says `@SiteFlo`.

### 2. Install it and copy the two keys

- **Install:** https://api.slack.com/apps/<APP_ID>/install-on-team (menu: **Install App**) →
  **Install to <workspace>** → **Allow**. Then copy the **Bot User OAuth Token** on that page
  (starts with `xoxb-`; not the `xoxp-` user token).
- **Signing Secret:** https://api.slack.com/apps/<APP_ID>/general (menu: **Basic Information**) →
  **App Credentials** → **Signing Secret** → **Show** → copy. Ignore the Client ID, Client Secret
  and Verification Token.

If a link says "we couldn't find that page", the browser isn't signed in to that workspace: use the
menu on the left of the app's page instead.

### 3. Save them as GitHub secrets

Each command asks for the value: paste it and press Enter (it isn't shown on screen or saved in
your shell history):

```bash
gh secret set SLACK_SIGNING_SECRET -R <owner>/<client>-site
gh secret set SLACK_BOT_TOKEN -R <owner>/<client>-site
```

The **Deploy Worker** workflow uploads them to the Worker on every deploy. Clients without these
secrets just skip that step.

### 4. Choose the channel and staff, then push

- In Slack, open the channel and type `/invite @SiteFlo` (the bot only sees channels it's in; private
  channels work too). If Slack finds no match, use the bot's actual name, or click the channel name
  → **Integrations** → **Add an App**. Slackbot's "talk it out with just yourself" note in a new
  channel doesn't matter.
- Get the **channel ID**: right-click the channel in the sidebar → **Copy link** (or **Copy** →
  **Copy link**); the ID is the last part of the link and starts with `C` (or `G` for some private
  channels). A link ending in `T…/D…` is a direct message, not a channel: the bot doesn't work in
  direct messages (its **Messages** tab only shows "This is still a work in progress").
- Get each person's **Slack email**: their profile picture → **Profile** → **Contact information**.
- In the client's `worker/wrangler.toml`, under `[vars]`, remove the `#` in front of the Slack lines
  and fill them in:

  ```toml
  SLACK_CHANNEL_IDS = "C0123ABCD"                     # several: "C0123ABCD,C0456EFGH"
  SLACK_STAFF_EMAILS = "jane@example.org,bob@gmail.com"
  SLACK_STAFF_DOMAINS = "thecinderellaproject.com"    # everyone with an @thecinderellaproject.com address
  SLACK_HOURLY_LIMIT = "20"                           # requests per person per hour
  SLACK_CHECKUP = "off"                               # optional: no monthly check-up post
  ```

  Lines that still start with `#` are switched off. With no channel, or no staff emails or domains,
  the bot does nothing. The email is the one on the person's Slack profile. A domain matches
  exactly (`sub.thecinderellaproject.com` doesn't count).
- `git add worker/wrangler.toml && git commit -m "Turn on Slack edits" && git push` → **Deploy Worker** runs.
  (To try values without a commit: `cd worker && npx wrangler deploy --var SLACK_CHANNEL_IDS:C0123ABCD …`;
  the next push replaces them with what's in the file.)

### 5. Verify the address and try it

- https://api.slack.com/apps/<APP_ID>/event-subscriptions → next to **Request URL**, click
  **Retry** until it shows **Verified** → **Save Changes**. If there's no Retry and **Save Changes**
  stays grey, Slack thinks nothing changed: add `?v=2` to the end of the URL (the Worker ignores it),
  press Enter, wait for **Verified**, then **Save Changes**.
- Go through **Check the app's settings** below once (two minutes; it catches every problem we've hit).
- In the channel, post a small request ("change the phone number on the Contact page to …").
  The bot answers in a thread. Press **Cancel** the first time to check nothing changes, then try
  again and **Approve**: a new commit appears on `main` and the site updates in a few minutes.

## Check the app's settings

On https://api.slack.com/apps → the app, using the left menu. Most changes show a banner asking you
to reinstall; the banner's link may do nothing, so use **Install App** → **Reinstall to <workspace>**
→ **Allow**. The bot token usually stays the same (if it changes, set the GitHub secret again).

| Menu item | Should be |
|---|---|
| **Socket Mode** | **Enable Socket Mode** switch **off**. (The "Enabled? Yes" column below it only lists what Socket Mode would affect.) When on, Slack never calls the Worker. |
| **Event Subscriptions** | **Enable Events** on; Request URL `…/slack/events` **Verified**; **Subscribe to bot events** has `message.channels` and `message.groups` (others are harmless) |
| **Interactivity & Shortcuts** | **Interactivity** on; Request URL `https://<worker>/slack/interactions` (not `/events`) |
| **OAuth & Permissions** → **Bot Token Scopes** | `chat:write`, `channels:history`, `groups:history`, `users:read`, `users:read.email`, `reactions:write` (only for the 👀; without it the bot works but shows no 👀), `files:read` (photos; without it the bot answers photos with "needs permission to read files") |

To check the installed permissions from the terminal (the token is read from the prompt):

```bash
read -s "T?Bot token: "; curl -s -D - -o /dev/null -H "Authorization: Bearer $T" https://slack.com/api/auth.test | grep -i x-oauth-scopes; unset T
```

## When it doesn't work

Watch the Worker while you post in the channel: `cd worker && npx wrangler tail --format pretty`
(or Cloudflare → Workers → the client's Worker → **Logs**).

| What you see | Cause and fix |
|---|---|
| The Slack **desktop app** doesn't show the bot's thread updates or the finished draft (the web app does) | Refresh with **⌘R** (Ctrl+R on Windows), or **Help → Troubleshooting → Clear Cache and Restart**. |
| The bot ignores a request | Requests posted as a **reply in a thread** are ignored by design (only answers to the bot's own question count): post it in the channel. |
| Nothing reaches the Worker when you post | **Socket Mode** is on, the Request URL isn't verified or saved, or events are off (see the table above). A request you send yourself (`curl -X POST https://<worker>/slack/events`) shows up and gets 401, so the Worker itself is fine. |
| Log: `slack onMessage failed: Slack users.info: missing_scope` | `users:read` / `users:read.email` are missing: add them under **Bot Token Scopes**, reinstall. |
| Requests reach the Worker but the bot says nothing, no error | The channel isn't in `SLACK_CHANNEL_IDS`, or the sender's Slack email isn't listed, or **Deploy Worker** didn't run after the change. |
| 👀 or "Working on it…" and then nothing for over two minutes | Check the log for the Claude or GitHub error. The reply is in a **thread** under your message ("1 reply"), not in the channel itself. |
| Slack: "This app is not configured to handle interactive responses" | **Interactivity** is off or has no Request URL (see the table above). |
| "This is still a work in progress" | You're in the bot's **Messages** tab (a direct message). Post in the channel instead. |
| Bot: "I can't open photos yet: the Slack app needs permission to read files" | Add `files:read` under **Bot Token Scopes** and reinstall. |
| Approve card shows the change but no picture | Slack couldn't load the image from the site's media address (`R2_PUBLIC_URL`); check the bucket's public access. The photo is still stored. |

## Changing or removing it

- Add a channel or person: edit the `SLACK_*` lines in `worker/wrangler.toml`, push.
- Buttons stop working after the Worker moved: https://api.slack.com/apps/<APP_ID>/interactive-messages
  → update the **Request URL** (and the one on event-subscriptions).
- New keys (leak, someone left): https://api.slack.com/apps/<APP_ID>/general → **Regenerate** the
  Signing Secret, or reinstall on /oauth for a new bot token; set the GitHub secret again and re-run
  **Deploy Worker** (Actions tab → Deploy Worker → **Run workflow**).
- Turn it off: put the `#` back in front of `SLACK_CHANNEL_IDS` and push, or delete the app on
  https://api.slack.com/apps/<APP_ID>/general (bottom of the page).

## Security

- Every message and button press from Slack is checked against the **Signing Secret**, so nobody
  else can pretend to be Slack. Old requests are refused.
- The bot looks up the person's Slack email and acts only for listed staff, in listed channels.
- Nothing changes on the site until someone presses **Approve**, and each change is one commit you
  can undo with `git revert`.
- Each person can ask for at most `SLACK_HOURLY_LIMIT` drafts an hour (default 20), which caps the
  Claude cost.
- The message text is sent to Slack's servers (as with any Slack message) and to Claude, to draft
  the change. Don't post passwords or private data in the channel.
- Photos: the router hands a client only files posted in that client's channel (remembered for a
  day), downloads them with the bot token itself, and passes on only JPG, PNG or WebP up to 10 MB.
  A photo is stored in the site's media bucket when the bot drafts the change, before Approve, at an
  unlisted address; a cancelled one stays there unused, like an unsaved staff-form upload.
