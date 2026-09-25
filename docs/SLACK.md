# Slack: staff ask for edits in a channel

Optional. Staff post a request in their Slack channel, for example *"change the Contact page hours
to 9–5"*. The **1WP** bot puts 👀 on the message and answers in a thread ("Working on it…", then
what it's doing), which can take up to a minute for a new article. It ends with a before/after of
the change and two buttons, **Approve** and **Cancel**, and the 👀 goes away. Only an approved
change is saved to `content.json` (one commit, through the same Edit module as the staff form) and
the site updates a few minutes later.

What it does **not** do:

- No deletes, no menu changes, no settings. Those stay in the staff form.
- Nothing is published until someone presses **Approve**.
- It only reads and answers in the channels you list, and only for the staff you list. Everyone
  else is ignored.

Each client has its own Slack app, named 1WP, pointing at that client's Worker.

## Set it up (about 15 minutes)

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

The bot's name in Slack is the app's name (**1WP** unless you changed it while creating it). Use that
name wherever this guide says `@1WP`.

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

- In Slack, open the channel and type `/invite @1WP` (the bot only sees channels it's in; private
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
| **OAuth & Permissions** → **Bot Token Scopes** | `chat:write`, `channels:history`, `groups:history`, `users:read`, `users:read.email`, `reactions:write` (only for the 👀; without it the bot works but shows no 👀) |

To check the installed permissions from the terminal (the token is read from the prompt):

```bash
read -s "T?Bot token: "; curl -s -D - -o /dev/null -H "Authorization: Bearer $T" https://slack.com/api/auth.test | grep -i x-oauth-scopes; unset T
```

## When it doesn't work

Watch the Worker while you post in the channel: `cd worker && npx wrangler tail --format pretty`
(or Cloudflare → Workers → the client's Worker → **Logs**).

| What you see | Cause and fix |
|---|---|
| Nothing reaches the Worker when you post | **Socket Mode** is on, the Request URL isn't verified or saved, or events are off (see the table above). A request you send yourself (`curl -X POST https://<worker>/slack/events`) shows up and gets 401, so the Worker itself is fine. |
| Log: `slack onMessage failed: Slack users.info: missing_scope` | `users:read` / `users:read.email` are missing: add them under **Bot Token Scopes**, reinstall. |
| Requests reach the Worker but the bot says nothing, no error | The channel isn't in `SLACK_CHANNEL_IDS`, or the sender's Slack email isn't listed, or **Deploy Worker** didn't run after the change. |
| 👀 or "Working on it…" and then nothing for over two minutes | Check the log for the Claude or GitHub error. The reply is in a **thread** under your message ("1 reply"), not in the channel itself. |
| Slack: "This app is not configured to handle interactive responses" | **Interactivity** is off or has no Request URL (see the table above). |
| "This is still a work in progress" | You're in the bot's **Messages** tab (a direct message). Post in the channel instead. |

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
