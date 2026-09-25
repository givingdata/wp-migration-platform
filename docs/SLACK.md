# Slack: staff ask for edits in a channel

Optional. Staff post a request in their Slack channel, for example *"change the Contact page hours
to 9–5"*. The **1WP** bot replies in a thread with a before/after of the change and two buttons,
**Approve** and **Cancel**. Only an approved change is saved to `content.json` (one commit, through
the same Edit module as the staff form) and the site updates a few minutes later.

What it does **not** do:

- No deletes, no menu changes, no settings. Those stay in the staff form.
- Nothing is published until someone presses **Approve**.
- It only reads and answers in the channels you list, and only for the staff you list. Everyone
  else is ignored.

Each client has its own Slack app, named 1WP, pointing at that client's Worker.

## Set it up (about 15 minutes)

Run the commands in the **client folder** (e.g. `clients/<client>-site`). You need the Worker URL
(the `WORKER_URL` variable that `deploy.sh` set, or the `https://….workers.dev` address it printed).

### 1. Create the Slack app from the link

```bash
node scripts/slack-app-link.mjs --open
```

This fills the Worker URL into `slack/manifest.json` and opens Slack's "create app" page with
everything already set (name, permissions, events, buttons), and copies the link to the clipboard.
If the Worker URL isn't found, add it: `--worker-url https://<client>-worker.<account>.workers.dev`.

In the page: pick the client's workspace → **Next** → **Create**. Slack may say the request URL
isn't verified yet; that's expected (the Worker doesn't have the Slack secret yet). Step 4 fixes it.

Your new app's page has an address like `https://api.slack.com/apps/A0123ABCD/general`. The
`A0123ABCD` part is the **app ID**; the links below use it. All your apps: https://api.slack.com/apps

### 2. Install it and copy the two keys

- **Install:** https://api.slack.com/apps/<APP_ID>/oauth → **Install to Workspace** → **Allow**.
  Then copy the **Bot User OAuth Token** on that same page (starts with `xoxb-`).
- **Signing Secret:** https://api.slack.com/apps/<APP_ID>/general → **App Credentials** →
  **Signing Secret** → **Show** → copy.

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
  channels work too).
- Get the **channel ID**: click the channel name at the top → the **About** tab → the ID is at the
  very bottom (starts with `C`, or `G` for some private channels). Copy it.
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
  **Retry** (or **Change** and save the same URL) until it shows **Verified** → **Save Changes**.
- In the channel, post a small request ("change the phone number on the Contact page to …").
  The bot answers in a thread. Press **Cancel** the first time to check nothing changes, then try
  again and **Approve**: a new commit appears on `main` and the site updates in a few minutes.

If the bot stays silent: is it in the channel (step 4), is the channel ID in `SLACK_CHANNEL_IDS`,
is your Slack email listed, and did **Deploy Worker** go green? Then check the Worker logs:
Cloudflare → Workers → the client's Worker → **Logs**.

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
