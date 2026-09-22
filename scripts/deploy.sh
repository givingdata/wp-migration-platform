#!/usr/bin/env bash
# One-time setup of all Cloudflare resources for a client, then first deploy.
#
#   bash scripts/deploy.sh
#
# Safe to re-run: existing resources are reused. Settings can be given as env vars
# to skip the prompts:
#
#   CLIENT_SLUG=acme SITE_NAME="Acme Arts" \
#   SITE_DOMAIN=acmearts.org bash scripts/deploy.sh
#
# Creates: KV namespace, R2 bucket (+ public r2.dev URL), Worker (+ secrets),
# Pages project for the site, Pages project for the staff form (deployed with its
# generated config), optional custom domain, optional GitHub secrets/variables.
# Writes the resulting IDs into worker/wrangler.toml — commit that file afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="$ROOT/worker"
TOML="$WORKER_DIR/wrangler.toml"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

ask() { # ask VAR "Prompt" [default]
  local var=$1 prompt=$2 default=${3:-}
  if [ -n "${!var:-}" ]; then return; fi
  local reply=""
  read -r -p "  $prompt${default:+ [$default]}: " reply || true   # EOF (non-interactive) → default
  printf -v "$var" '%s' "${reply:-$default}"
}

ask_secret() { # ask_secret VAR "Prompt"
  local var=$1 prompt=$2
  if [ -n "${!var:-}" ]; then return; fi
  local reply=""
  read -r -s -p "  $prompt: " reply || true
  echo
  printf -v "$var" '%s' "$reply"
}

confirm() { # confirm "Question" → 0 for yes (ASSUME_YES=1 answers yes)
  if [ "${ASSUME_YES:-}" = 1 ]; then return 0; fi
  local reply=""
  read -r -p "  $1 [y/N]: " reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

wrangler() { (cd "$WORKER_DIR" && npx --no-install wrangler "$@"); }
# Pages commands run from an empty directory: next to worker/wrangler.toml Wrangler
# treats them as that Worker's, and in the repo root (an npm workspace) its app
# detection fails.
PAGES_CWD="$(mktemp -d)"
pages() { (cd "$PAGES_CWD" && "$WORKER_DIR/node_modules/.bin/wrangler" pages "$@"); }

# ---- Prerequisites -----------------------------------------------------------

bold "Checking prerequisites"
for cmd in node npm python3 openssl git; do
  command -v "$cmd" >/dev/null || die "$cmd is required"
done
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || die "Node 22+ is required"
(cd "$WORKER_DIR" && npm ci --no-fund --no-audit >/dev/null)
wrangler whoami >/dev/null 2>&1 || die "Not logged in to Cloudflare. Run: cd worker && npx wrangler login"
info "wrangler $(wrangler --version | tail -1), logged in"
[ -n "$(git -C "$ROOT" remote get-url upstream 2>/dev/null)" ] || warn "No upstream remote: run this in a client repo made with scripts/new-client.sh, not the platform template"

# ---- Settings ---------------------------------------------------------------

bold "Client settings"
default_repo="$(git -C "$ROOT" remote get-url origin 2>/dev/null | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
ask CLIENT_SLUG "Short client id (lowercase, used in resource names, e.g. acme)"
[[ "$CLIENT_SLUG" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || die "CLIENT_SLUG must be lowercase letters, digits and dashes"
ask SITE_NAME "Site name (e.g. Acme Arts)"
ask SITE_DOMAIN "Production domain for the site (blank to use *.pages.dev)" ""
ask GITHUB_REPO "GitHub repo (owner/name)" "$default_repo"

WORKER_NAME="${WORKER_NAME:-$CLIENT_SLUG-content-worker}"
KV_TITLE="${KV_TITLE:-$CLIENT_SLUG-content}"
BUCKET="${BUCKET:-$CLIENT_SLUG-media}"
PAGES_PROJECT="${PAGES_PROJECT:-$CLIENT_SLUG-site}"
FORM_PROJECT="${FORM_PROJECT:-$CLIENT_SLUG-form}"
FORM_URL="https://$FORM_PROJECT.pages.dev"

info "Worker: $WORKER_NAME | KV: $KV_TITLE | R2: $BUCKET | Pages: $PAGES_PROJECT, $FORM_PROJECT"

# ---- KV ---------------------------------------------------------------------

bold "KV namespace"
kv_id() {
  wrangler kv namespace list 2>/dev/null | python3 -c '
import json, sys
title = sys.argv[1]
try:
    data = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
print(next((n["id"] for n in data if n.get("title") == title), ""))
' "$KV_TITLE"
}
KV_ID="$(kv_id)"
if [ -z "$KV_ID" ]; then
  wrangler kv namespace create "$KV_TITLE" >/dev/null
  KV_ID="$(kv_id)"
  [ -n "$KV_ID" ] || die "Created KV namespace but could not read its id (check: npx wrangler kv namespace list)"
  info "Created $KV_TITLE ($KV_ID)"
else
  info "Using existing $KV_TITLE ($KV_ID)"
fi

# ---- R2 ---------------------------------------------------------------------

bold "R2 bucket"
if r2_out="$(wrangler r2 bucket create "$BUCKET" 2>&1)"; then
  info "Created bucket $BUCKET"
elif echo "$r2_out" | grep -qi "already exists"; then
  info "Using existing bucket $BUCKET"
else
  echo "$r2_out"; die "Could not create R2 bucket $BUCKET (is R2 enabled on the account?)"
fi

if [ -z "${R2_PUBLIC_URL:-}" ]; then
  wrangler r2 bucket dev-url enable "$BUCKET" --force >/dev/null 2>&1 || true
  R2_PUBLIC_URL="$(wrangler r2 bucket dev-url get "$BUCKET" 2>/dev/null | grep -Eo 'https://pub-[a-z0-9]+\.r2\.dev' | head -1 || true)"
fi
if [ -n "$R2_PUBLIC_URL" ]; then
  info "Public media URL: $R2_PUBLIC_URL"
  warn "r2.dev URLs are rate-limited; for production connect a custom domain to the bucket and re-run with R2_PUBLIC_URL=https://media.<domain>"
else
  warn "Could not determine the bucket's public URL. Enable public access in the dashboard (R2 → $BUCKET → Settings) and re-run with R2_PUBLIC_URL=…"
fi

# ---- Worker config ----------------------------------------------------------

bold "Writing worker/wrangler.toml"
W_NAME="$WORKER_NAME" W_KV="$KV_ID" W_BUCKET="$BUCKET" W_SITE="$SITE_NAME" W_REPO="$GITHUB_REPO" \
W_R2="${R2_PUBLIC_URL:-}" W_ORIGINS="$FORM_URL" python3 - "$TOML" <<'PY'
import json, os, re, sys
path = sys.argv[1]
s = open(path).read()
def setkey(key, value, text):
    # json.dumps gives a valid TOML basic string (quotes/backslashes escaped).
    new, n = re.subn(rf'^(#\s*)?{key} = "[^"\n]*"', lambda m: f"{key} = {json.dumps(value)}", text, count=1, flags=re.M)
    if not n:
        raise SystemExit(f"{key} not found in wrangler.toml")
    return new
for key, env in [("name", "W_NAME"), ("id", "W_KV"), ("bucket_name", "W_BUCKET"), ("SITE_NAME", "W_SITE"),
                 ("GITHUB_REPO", "W_REPO"), ("R2_PUBLIC_URL", "W_R2"), ("ALLOWED_ORIGINS", "W_ORIGINS")]:
    s = setkey(key, os.environ[env], s)
open(path, "w").write(s)
PY
info "Updated name, KV id, bucket, SITE_NAME, GITHUB_REPO, R2_PUBLIC_URL, ALLOWED_ORIGINS"

# ---- Secrets ----------------------------------------------------------------

bold "Secrets"
FORM_API_KEY="${FORM_API_KEY:-$(openssl rand -hex 32)}"
ask_secret CLAUDE_API_KEY "Claude API key (sk-ant-…)"
[ -n "$CLAUDE_API_KEY" ] || die "Claude API key is required"
info "GitHub token: fine-grained PAT for $GITHUB_REPO with Contents: Read and write"
ask_secret CONTENT_REPO_TOKEN "GitHub token for content commits"
[ -n "$CONTENT_REPO_TOKEN" ] || die "GitHub token is required"

# ---- Deploy Worker ----------------------------------------------------------

bold "Deploying Worker"
deploy_out="$(wrangler deploy 2>&1)" || { echo "$deploy_out"; die "wrangler deploy failed"; }
WORKER_URL="$(echo "$deploy_out" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1 || true)"
printf '%s' "$FORM_API_KEY" | wrangler secret put API_KEY >/dev/null
printf '%s' "$CLAUDE_API_KEY" | wrangler secret put CLAUDE_API_KEY >/dev/null
printf '%s' "$CONTENT_REPO_TOKEN" | wrangler secret put GITHUB_TOKEN >/dev/null
info "Deployed ${WORKER_URL:-(URL not detected — see dashboard)} and set API_KEY, CLAUDE_API_KEY, GITHUB_TOKEN"
if [ -n "$WORKER_URL" ] && curl -fsS "$WORKER_URL/health" >/dev/null 2>&1; then info "Health check OK"; fi

# ---- Pages projects ---------------------------------------------------------

bold "Pages projects"
pages_exists() { pages project list 2>/dev/null | grep -Eq "│ $1 +│"; }
for project in "$PAGES_PROJECT" "$FORM_PROJECT"; do
  if pages_exists "$project"; then
    info "Using existing $project"
  else
    # --force creates a classic Pages project instead of delegating to Workers
    # (only needed at creation; later deploys go straight to Pages).
    pages project create "$project" --production-branch main --force >/dev/null 2>&1 || true
    pages_exists "$project" || die "Could not create Pages project $project"
    info "Created $project"
  fi
done

bold "Deploying staff form"
form_tmp="$(mktemp -d)"
trap 'rm -rf "$form_tmp" "$PAGES_CWD"' EXIT
cp "$ROOT"/form/index.html "$ROOT"/form/form-handler.js "$ROOT"/form/signing.js "$form_tmp"/
cat > "$form_tmp/config.js" <<JS
// Generated by scripts/deploy.sh — not committed (contains the API key).
export default {
  siteName: $(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$SITE_NAME"),
  workerUrl: "${WORKER_URL}",
  apiKey: "${FORM_API_KEY}",
  hmacSecret: null,
  designSpecs: null,
};
JS
pages deploy "$form_tmp" --project-name "$FORM_PROJECT" --branch main --commit-dirty=true >/dev/null
info "Form deployed to $FORM_URL"
warn "Protect it now: Zero Trust → Access → Applications → Self-hosted → $FORM_PROJECT.pages.dev, allow staff emails only"

# ---- Custom domain ----------------------------------------------------------

if [ -n "$SITE_DOMAIN" ]; then
  bold "Custom domain"
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$PAGES_PROJECT/domains" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
      --data "{\"name\":\"$SITE_DOMAIN\"}")"
    case "$status" in
      200) info "Linked $SITE_DOMAIN to $PAGES_PROJECT (DNS is configured automatically if the zone is on this account)" ;;
      409) info "$SITE_DOMAIN already linked" ;;
      *) warn "Linking $SITE_DOMAIN failed (HTTP $status) — add it in Pages → $PAGES_PROJECT → Custom domains" ;;
    esac
  else
    warn "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to link automatically, or add $SITE_DOMAIN in Pages → $PAGES_PROJECT → Custom domains"
  fi
fi
SITE_URL="${SITE_DOMAIN:+https://$SITE_DOMAIN}"
SITE_URL="${SITE_URL:-https://$PAGES_PROJECT.pages.dev}"

# ---- GitHub secrets & variables ---------------------------------------------

bold "GitHub Actions configuration"
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && confirm "Set secrets and variables on $GITHUB_REPO with gh?"; then
  ask CLOUDFLARE_ACCOUNT_ID "Cloudflare account ID" "$(wrangler whoami 2>/dev/null | grep -Eo '[0-9a-f]{32}' | head -1)"
  ask_secret CLOUDFLARE_API_TOKEN "Cloudflare API token for CI (Workers Scripts:Edit, Pages:Edit, KV:Edit, R2:Edit)"
  gh secret set CLOUDFLARE_API_TOKEN -R "$GITHUB_REPO" --body "$CLOUDFLARE_API_TOKEN"
  gh secret set CLOUDFLARE_ACCOUNT_ID -R "$GITHUB_REPO" --body "$CLOUDFLARE_ACCOUNT_ID"
  gh secret set CLOUDFLARE_KV_NAMESPACE_ID -R "$GITHUB_REPO" --body "$KV_ID"
  gh secret set CLOUDFLARE_R2_BUCKET_NAME -R "$GITHUB_REPO" --body "$BUCKET"
  gh secret set FORM_API_KEY -R "$GITHUB_REPO" --body "$FORM_API_KEY"
  gh secret set CLAUDE_API_KEY -R "$GITHUB_REPO" --body "$CLAUDE_API_KEY"
  gh secret set CONTENT_REPO_TOKEN -R "$GITHUB_REPO" --body "$CONTENT_REPO_TOKEN"
  gh variable set CLOUDFLARE_PAGES_PROJECT -R "$GITHUB_REPO" --body "$PAGES_PROJECT"
  gh variable set SITE_URL -R "$GITHUB_REPO" --body "$SITE_URL"
  gh variable set SITE_NAME -R "$GITHUB_REPO" --body "$SITE_NAME"
  [ -n "$WORKER_URL" ] && gh variable set WORKER_URL -R "$GITHUB_REPO" --body "$WORKER_URL"
  info "Secrets and variables set"
else
  warn "Skipped. Set them by hand — see docs/DEPLOYMENT_CHECKLIST.md step 4 (FORM_API_KEY is printed below)."
fi

# ---- Summary ----------------------------------------------------------------

bold "Done"
cat <<EOF
  Worker:        ${WORKER_URL:-see Cloudflare dashboard}
  Staff form:    $FORM_URL   (put it behind Cloudflare Access!)
  Site:          $SITE_URL   (first deploy happens in GitHub Actions)
  Media:         ${R2_PUBLIC_URL:-not public yet}
  Form API key:  $FORM_API_KEY   (store it in your password manager)

Next:
  1. git add worker/wrangler.toml && git commit -m "Configure $CLIENT_SLUG resources" && git push
  2. Migrate content:  R2_PUBLIC_URL=$R2_PUBLIC_URL python wordpress_export.py --wordpress-url <old site> --output content.json
     (needs R2 API credentials in .env), then commit and push content.json → site deploys.
  3. Submit a test entry through the form and watch the Rebuild workflow.
EOF
