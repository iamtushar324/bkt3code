#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTED_BRANCH="bkmain"
DEPLOYED_SHA_FILE="/home/ubuntu/.t3/bkt3-dev/deployed-sha"
WORKFLOW_RUNS_URL="https://api.github.com/repos/beknown-work/bkt3code/actions/workflows/deploy-bkt3.yml/runs?branch=bkmain&event=push&per_page=20"

CURRENT_BRANCH="$(git -C "$REPO_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "ERROR: automatic bkt3 deployment requires branch '$EXPECTED_BRANCH' (found '${CURRENT_BRANCH:-detached HEAD}')." >&2
  exit 1
fi

git -C "$REPO_DIR" fetch --quiet --prune origin "$EXPECTED_BRANCH"
LOCAL_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
REMOTE_SHA="$(git -C "$REPO_DIR" rev-parse "origin/$EXPECTED_BRANCH")"
DEPLOYED_SHA="$(sed -n '1p' "$DEPLOYED_SHA_FILE" 2>/dev/null || true)"

if [[ "$DEPLOYED_SHA" == "$REMOTE_SHA" ]]; then
  exit 0
fi

if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]] && \
  git -C "$REPO_DIR" merge-base --is-ancestor "$REMOTE_SHA" "$LOCAL_SHA"; then
  echo "Local bkmain is ahead of origin/bkmain; automatic deployment deferred until it is pushed."
  exit 0
fi

# A rate-limited or unreachable GitHub API is a reason to wait, not a unit
# failure; the next timer tick retries.
#
# -L: the repository has moved owner more than once, and GitHub answers the old
# path with a 301 whose JSON body carries no `workflow_runs`; curl -f does not
# treat that as an error. The token (exported by t3-deploy-with-github-token)
# lifts the 60 requests/hour anonymous limit and keeps working if the
# repository is private.
CURL_AUTH=()
if [[ -n "${GH_TOKEN:-}" ]]; then
  CURL_AUTH=(-H "Authorization: Bearer $GH_TOKEN")
fi
if ! RUNS_JSON="$(curl --connect-timeout 5 --max-time 20 -fsSL \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "${CURL_AUTH[@]}" \
  "$WORKFLOW_RUNS_URL")"; then
  echo "Could not read GitHub validation runs for $REMOTE_SHA; deployment deferred."
  exit 0
fi
# Any other shape (an error or redirect body) is also a reason to wait.
if ! jq -e '.workflow_runs | type == "array"' >/dev/null 2>&1 <<<"$RUNS_JSON"; then
  echo "GitHub returned no workflow runs for $REMOTE_SHA ($(jq -r '.message // "unexpected response"' 2>/dev/null <<<"$RUNS_JSON" || echo "unparsable response")); deployment deferred."
  exit 0
fi
RUN_CONCLUSION="$(jq -r --arg sha "$REMOTE_SHA" \
  '[.workflow_runs[] | select(.head_sha == $sha)][0].conclusion // empty' \
  <<<"$RUNS_JSON")"
RUN_ID="$(jq -r --arg sha "$REMOTE_SHA" \
  '[.workflow_runs[] | select(.head_sha == $sha)][0].id // empty' \
  <<<"$RUNS_JSON")"

if [[ -z "$RUN_CONCLUSION" || -z "$RUN_ID" ]]; then
  echo "GitHub validation for $REMOTE_SHA is not finished yet; deployment deferred."
  exit 0
fi

if [[ "$RUN_CONCLUSION" != "success" ]]; then
  echo "GitHub validation for $REMOTE_SHA concluded '$RUN_CONCLUSION'; deployment blocked."
  exit 0
fi

echo "GitHub validation succeeded for $REMOTE_SHA; starting bkt3 deployment."
exec "$REPO_DIR/deploy/bkt3/deploy.sh" "$REMOTE_SHA" "$RUN_ID"
