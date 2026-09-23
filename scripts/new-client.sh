#!/usr/bin/env bash
# Create a private GitHub repo for a new client from this platform, keeping a link
# back to the platform so fixes can be pulled in later with `git pull upstream main`.
#
#   bash scripts/new-client.sh <client-slug> [github-owner]
#   e.g. bash scripts/new-client.sh acme givingdata
#
# Result: github.com/<owner>/<slug>-site and a local clone in $CLIENTS_DIR/<slug>-site.
# CLIENTS_DIR defaults to ../clients if that folder exists, otherwise the folder next to
# this one (..). Remotes:
#   origin   → the client repo (deploys, content, client settings)
#   upstream → the platform template (code updates)
set -euo pipefail

slug="${1:-}"
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] || { echo "Usage: bash scripts/new-client.sh <client-slug> [github-owner]" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform_url="$(git -C "$ROOT" remote get-url origin)"
owner="${2:-$(gh api user --jq .login)}"
repo="$owner/$slug-site"
parent="$(dirname "$ROOT")"
[ -d "$parent/clients" ] && default_clients="$parent/clients" || default_clients="$parent"
dest="${CLIENTS_DIR:-$default_clients}/$slug-site"

command -v gh >/dev/null && gh auth status >/dev/null 2>&1 || { echo "Log in first: gh auth login" >&2; exit 1; }
[ -e "$dest" ] && { echo "$dest already exists" >&2; exit 1; }

echo "Creating private repo $repo"
gh repo create "$repo" --private --description "Website for $slug (built on wp-migration-platform)" >/dev/null

echo "Cloning platform into $dest"
git clone --quiet --origin upstream "$platform_url" "$dest"
git -C "$dest" remote add origin "https://github.com/$repo.git"
git -C "$dest" push --quiet -u origin main

cat <<EOF

Done: https://github.com/$repo
Local copy: $dest

Next (in the new folder):
  cd "$dest"
  npm install
  CLIENT_SLUG=$slug SITE_NAME="<Site name>" bash scripts/deploy.sh
  → then follow docs/DEPLOYMENT_CHECKLIST.md from step 3.

Pull platform updates later with:  git pull upstream main
EOF
