# 1wp-slack: one Slack app for every client (scaffold)

Status: **deployed 2026-09-25** at https://1wp-slack.weathered-sun-5146.workers.dev. How to use it:
`docs/SLACK.md`. Tests: `npm test` here (end to end with the client Worker's real `slack.js`).

## Why

All clients live in one **free** Slack workspace (FloMySite.com). Each client's staff are regular
members, in a private channel named after their site. The free plan allows at most **10 apps**,
so "one 1WP app per client" stops at 10 clients. Instead there is **one** 1WP app, and a small
Worker in front of the client Workers decides which client a message belongs to.

Clients are **records in the router's KV** (Cloudflare's key-value store), not lines in its
config. Adding, pausing or removing a client never redeploys the router. Everything used here is
on Cloudflare's free plan.

## How a request flows

```
 Slack ──(Slack-signed)──▶ 1wp-slack ──(signed with the client's key)──▶ client Worker /slack/inbox
                           │ checks Slack's signature, drops repeats           │ staff check, Claude
                           │ channel → client (KV), skips paused clients       │ drafts, Approve →
                           │                                                   │ Edit module commits
 Slack ◀──(bot token)───── 1wp-slack /api/<method> ◀──(signed with the client's key)──┘
                           only chat/reaction calls in that client's own channel,
                           users.info only for people seen in that channel
```

**Keys.** The router holds the only Slack secrets (the signing secret and bot token). Each client
has one key, `SLACK_ROUTER_KEY = HMAC(ROUTER_SECRET, "<client>")`. The router can always work it
out again, so no per-client key list is stored. Requests in both directions are signed with it,
using the same timestamp + HMAC scheme as the staff form (`worker/src/auth.js`). A leaked client
key lets someone post only in that client's channel.

## Setup, onboarding, management

**Once, ever**
1. Create the 1WP app from `manifest.json` (`ROUTER_URL` filled in), or move the existing
   Cinderella app to it (below). New compared with today: `groups:write` (create private channels,
   add people) and the `team_join` event (someone joined the workspace).
2. Create the router's KV namespace, set its four secrets, and deploy it.

**Adding a client**: `node scripts/slack-add-client.mjs <client> --worker-url … --domain <their domain>`

| Step | |
|---|---|
| Router creates private channel `#<client>`; the bot is in it | automatic |
| Router saves the client record (URL, channel, staff emails/domains) | automatic |
| Router adds you (`SUPPORT_EMAILS`) and staff already in the workspace | automatic |
| Client repo gets `SLACK_ROUTER_KEY`; its wrangler.toml gets the router URL, channel and staff; `--push` deploys | automatic |
| **Invite their staff to the workspace** | **you**: Slack has no invite API on the free plan. Send an invite link or type their emails. |
| New member joins → router matches their email to a client's staff list → adds them to the channel | automatic |

The dashboard's Set up clients page can later run the same script behind a button.

**Managing**

| Task | How |
|---|---|
| Add a staff member | Re-run with the full `--emails` list (or add their domain once), then invite them |
| Remove a staff member | Re-run without them and with `--prune`: the router removes non-staff from the channel (never `SUPPORT_EMAILS`). Deactivating their account is manual on the free plan. |
| Pause / resume a client | `--pause` / `--resume`. The router ignores their channel; nothing is deleted |
| Remove a client | `--remove`: forgets the client and archives the channel (can be unarchived) |
| Rotate a client key | `--rotate-key --push`: the key version goes up, the old key stops working |
| List clients | `--list` |
| Rotate the bot token | Slack app → reinstall, `wrangler secret put SLACK_BOT_TOKEN` on the router only |

## Client Worker side (`worker/src/slack.js`)

- `POST /slack/inbox` (on when `SLACK_ROUTER_KEY` is set) checks the router's signature, then runs
  the **same** `onMessage` / `onAction` as direct mode, in `waitUntil`.
- `slackApi()` sends calls to `<SLACK_ROUTER_URL>/api/<method>` when `SLACK_CLIENT`,
  `SLACK_ROUTER_URL` and `SLACK_ROUTER_KEY` are set, otherwise straight to Slack.
- Direct mode (`SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`) still works, for a client with its own app.
- Shared with the router: `isStaffMessage`, `messageFromEvent`, `actionFromPayload`,
  `routerHeaders` / `verifyRouterRequest`, `slackDirect`, and `isStaff` (slack-access.js).

## Moving Cinderella over

Keep the existing app (A0C4D0Q9DC2). Its signing secret and a **new** bot token (the old one was
pasted in chat once) go into the router's secrets. Its manifest is replaced with `manifest.json`
(router URLs, `groups:write`, `team_join`). Then
`slack-add-client.mjs cinderella --existing-channel C0C57GHP732 --emails hello@flomysite.com --push`,
and the old `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` come off the Cinderella Worker and repo.

## Open points

- **Slack's 3-second ack:** the router acks at once and forwards in `waitUntil`. The client acks
  the forward at once and drafts in its own `waitUntil`.
- **Free-plan limits:** about 2 Worker requests and 2 KV writes per Slack message, against 100k
  requests and 1k KV writes a day.
- **team_join email:** needs `users:read.email`. If Slack leaves the email out of the event, fall
  back to `users.info`.
- **Staff lists live in two places:** the router's record (for adding people on join) and the
  client's wrangler.toml (the client's own check). The script writes both from one input.
- **`users.list` on every re-run** (to add existing members): fine for a workspace of hundreds.
