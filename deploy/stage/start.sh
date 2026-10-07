#!/usr/bin/env bash
# T3-CUSTOM(stage): Starts only the isolated stage T3 service.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_BRANCH="stage"
SERVER_BUNDLE="$REPO_DIR/apps/server/dist/bin.mjs"
BASE_DIR="/home/ubuntu/.t3/stage-dev"

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: stage may only start from branch '$EXPECTED_BRANCH' (found '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 1
fi

if [[ ! -f "$SERVER_BUNDLE" ]]; then
  echo "ERROR: T3 server bundle is missing: $SERVER_BUNDLE" >&2
  echo "Run deploy/stage/deploy.sh to install dependencies and build it." >&2
  exit 1
fi

export NODE_ENV="production"
export PATH="/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# /tmp is a RAM-backed tmpfs (50% of RAM) carrying systemd's default 80% per-user
# quota. Agent sessions inherit TMPDIR from this process, so scratch files landing
# there exhaust the quota and make every subsequent command fail with a bare
# EDQUOT. Keep temp files on disk, beside this deployment's own state.
export TMPDIR="$BASE_DIR/tmp"
mkdir -p "$TMPDIR"

# A restart wakes a settled thread whose monitors, background commands or
# subagents it cancelled, so the agent can re-arm them (only for projects with
# "continue threads after server update" on). See
# apps/server/src/orchestration-v2/restartBackgroundResume.expbkt3.ts.
export T3_RESTART_WAKE_SETTLED_BACKGROUND="1"

exec node "$SERVER_BUNDLE" serve \
  --mode web \
  --host "10.31.39.131" \
  --port "18086" \
  --base-dir "$BASE_DIR" \
  --no-browser \
  "/home/ubuntu/repos"
