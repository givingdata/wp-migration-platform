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

- Each client has a settings file (`~/Documents/1wp-ops/clients/<slug>.json`).
- `1wp-ops/provision.mjs` runs `scripts/new-client.sh` and `scripts/deploy.sh` from it,
  step by step, and is safe to re-run. The dashboard's **Set up clients** page runs it
  (operator only, over Tailscale).
- Manual steps for now: adding the repo to the content GitHub token, and the Cloudflare
  Access app for the staff form.

## Phase 2: setup in a private ops repo

- `1wp-ops` becomes a private GitHub repo; a workflow runs `provision.mjs` with the setup
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
