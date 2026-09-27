#!/usr/bin/env bash
# Installs the GitHub-built t3.dev artifact.
#
# This script lives in the bkmain worktree but deploys the t3code worktree
# (branch `t3main`). Application code is never built on the shared dev server;
# see docs/operations/deployments.md.
set -euo pipefail

REPO_DIR="${T3_REPO_DIR:-/home/ubuntu/repos/t3code}"
EXPECTED_BRANCH="t3main"
EXPECTED_SHA="${1:-${EXPECTED_SHA:-}}"
WORKFLOW_RUN_ID="${2:-${WORKFLOW_RUN_ID:-}}"
REPOSITORY="beknown-work/bkt3code"
SERVICE_NAME="t3-beknown.service"
HEALTH_URL="http://10.31.39.131:18082/"
DEPLOYED_SHA_FILE="/home/ubuntu/.t3/beknown-dev/deployed-sha"

exec 9>"/tmp/t3-deploy.lock"
if ! flock -n 9; then
  echo "ERROR: another t3 deployment is already running." >&2
  exit 1
fi

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: refusing to deploy from '${CURRENT_BRANCH:-detached HEAD}'; expected '$EXPECTED_BRANCH'." >&2
  exit 1
fi

if [[ -n "$(git -C "$REPO_DIR" status --porcelain)" ]]; then
  echo "ERROR: refusing to overwrite uncommitted changes in $REPO_DIR." >&2
  git -C "$REPO_DIR" status --short >&2
  exit 1
fi

echo "==> Fetching origin/$EXPECTED_BRANCH"
git -C "$REPO_DIR" fetch --prune origin "$EXPECTED_BRANCH"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse "origin/$EXPECTED_BRANCH")"

if [[ -n "$EXPECTED_SHA" && "$REMOTE_SHA" != "$EXPECTED_SHA" ]]; then
  echo "ERROR: refusing stale deploy; requested $EXPECTED_SHA but origin/$EXPECTED_BRANCH is $REMOTE_SHA." >&2
  exit 1
fi

echo "==> Fast-forwarding $EXPECTED_BRANCH to $REMOTE_SHA"
git -C "$REPO_DIR" merge --ff-only "origin/$EXPECTED_BRANCH"

export PATH="/home/ubuntu/.nvm/versions/node/v24.16.0/bin:/home/ubuntu/.local/bin:/home/ubuntu/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [[ -z "$WORKFLOW_RUN_ID" ]]; then
  WORKFLOW_RUN_ID="$(gh run list \
    --repo "$REPOSITORY" \
    --workflow deploy-t3.yml \
    --branch "$EXPECTED_BRANCH" \
    --event push \
    --status success \
    --json databaseId,headSha \
    --jq ".[] | select(.headSha == \"$REMOTE_SHA\") | .databaseId" \
    --limit 20 |
    sed -n '1p')"
fi

if [[ -z "$WORKFLOW_RUN_ID" ]]; then
  echo "ERROR: no successful GitHub workflow run found for $REMOTE_SHA." >&2
  exit 1
fi

ARTIFACT_NAME="t3-$REMOTE_SHA"
ARTIFACT_DIR="$(mktemp -d)"
BACKUP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf -- "$ARTIFACT_DIR" "$BACKUP_DIR"
}
trap cleanup EXIT

# The artifact carries only apps/*/dist. The server bundle resolves its
# runtime dependencies from node_modules on this host, so a dependency bump
# upstream leaves the new bundle loading old packages and crashing at start
# (effect beta.78 vs beta.102 did exactly that). Sync dependencies whenever the
# lockfile moves. This installs packages; it does not build application code.
LOCK_HASH_FILE="/home/ubuntu/.t3/beknown-dev/deployed-lock"
LOCK_HASH="$(sha256sum "$REPO_DIR/pnpm-lock.yaml" | cut -d" " -f1)"
if [[ "$LOCK_HASH" != "$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)" ]]; then
  echo "==> Lockfile changed; installing dependencies"
  pnpm --dir "$REPO_DIR" install --frozen-lockfile
  install -d -m 0700 "$(dirname "$LOCK_HASH_FILE")"
  printf '%s\n' "$LOCK_HASH" >"$LOCK_HASH_FILE"
else
  echo "==> Dependencies already match the lockfile"
fi

echo "==> Downloading GitHub-built artifact $ARTIFACT_NAME"
gh run download "$WORKFLOW_RUN_ID" \
  --repo "$REPOSITORY" \
  --name "$ARTIFACT_NAME" \
  --dir "$ARTIFACT_DIR"

ARTIFACT_SHA="$(sed -n '1p' "$ARTIFACT_DIR/SHA" 2>/dev/null || true)"
ARTIFACT_WEB="$ARTIFACT_DIR/apps/web/dist"
ARTIFACT_SERVER="$ARTIFACT_DIR/apps/server/dist"
if [[ "$ARTIFACT_SHA" != "$REMOTE_SHA" ]]; then
  echo "ERROR: artifact SHA '${ARTIFACT_SHA:-missing}' does not match $REMOTE_SHA." >&2
  exit 1
fi
if [[ ! -f "$ARTIFACT_WEB/index.html" || ! -f "$ARTIFACT_SERVER/bin.mjs" ]]; then
  echo "ERROR: GitHub artifact is missing the web client or server bundle." >&2
  exit 1
fi

echo "==> Installing GitHub-built application artifact"
mkdir -p "$BACKUP_DIR/apps/web" "$BACKUP_DIR/apps/server"
if [[ -d "$REPO_DIR/apps/web/dist" ]]; then
  cp -a "$REPO_DIR/apps/web/dist" "$BACKUP_DIR/apps/web/"
fi
if [[ -d "$REPO_DIR/apps/server/dist" ]]; then
  cp -a "$REPO_DIR/apps/server/dist" "$BACKUP_DIR/apps/server/"
fi
mkdir -p "$REPO_DIR/apps/web/dist" "$REPO_DIR/apps/server/dist"
rsync -a --delete "$ARTIFACT_WEB/" "$REPO_DIR/apps/web/dist/"
rsync -a --delete "$ARTIFACT_SERVER/" "$REPO_DIR/apps/server/dist/"

echo "==> Restarting $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo -n "==> Waiting for t3"
for _ in $(seq 1 60); do
  if curl --connect-timeout 1 --max-time 3 -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null; then
  echo " FAILED" >&2
  sudo systemctl --no-pager --lines=50 status "$SERVICE_NAME" >&2 || true
  echo "==> Restoring the previous application artifact"
  if [[ -d "$BACKUP_DIR/apps/web/dist" ]]; then
    rsync -a --delete "$BACKUP_DIR/apps/web/dist/" "$REPO_DIR/apps/web/dist/"
  fi
  if [[ -d "$BACKUP_DIR/apps/server/dist" ]]; then
    rsync -a --delete "$BACKUP_DIR/apps/server/dist/" "$REPO_DIR/apps/server/dist/"
  fi
  sudo systemctl restart "$SERVICE_NAME"
  exit 1
fi

DEPLOYED_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
if [[ "$DEPLOYED_SHA" != "$REMOTE_SHA" ]]; then
  echo "ERROR: deployed checkout $DEPLOYED_SHA does not match origin/$EXPECTED_BRANCH $REMOTE_SHA." >&2
  exit 1
fi

install -d -m 0700 "$(dirname "$DEPLOYED_SHA_FILE")"
umask 077
printf '%s\n' "$DEPLOYED_SHA" >"$DEPLOYED_SHA_FILE"
echo "==> t3 deployed at $DEPLOYED_SHA"
