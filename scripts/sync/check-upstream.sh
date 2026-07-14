#!/usr/bin/env bash
# check-upstream.sh — lightweight upstream drift monitor for valadrien-os.
# Read-only: fetches upstream, reports how far behind master is, notifies ntfy.
# Designed to run from a Mac LaunchAgent (see scripts/sync/dev.valadrien.upstream-check.plist)
# or any cron. Never modifies the working tree or branches.
#
# Env:
#   REPO_DIR      path to the valadrien-os clone (default: repo containing this script)
#   NTFY_TOPIC    ntfy topic name (required for notifications)
#   NTFY_SERVER   default https://ntfy.sh
#   BEHIND_WARN   notify when behind >= this many commits (default 25)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"
BEHIND_WARN="${BEHIND_WARN:-25}"

cd "$REPO_DIR"

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream https://github.com/paperclipai/paperclip.git
fi

git fetch upstream master --quiet
git fetch origin master --quiet 2>/dev/null || true

BEHIND=$(git rev-list --count master..upstream/master)
AHEAD=$(git rev-list --count upstream/master..master)
LATEST=$(git log -1 --format='%h %s' upstream/master)

echo "$(date -u +%FT%TZ) ahead=$AHEAD behind=$BEHIND latest_upstream=$LATEST"

if [[ "$BEHIND" -ge "$BEHIND_WARN" && -n "${NTFY_TOPIC:-}" ]]; then
  curl -fsS -m 10 \
    -H "Title: valadrien-os: $BEHIND commits behind upstream" \
    -H "Priority: default" \
    -H "Tags: arrows_counterclockwise" \
    -d "Fork is $BEHIND behind / $AHEAD ahead of paperclipai/paperclip. Latest upstream: $LATEST. Run scripts/sync/sync-upstream.sh when ready." \
    "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null || echo "ntfy notify failed (non-fatal)"
fi
