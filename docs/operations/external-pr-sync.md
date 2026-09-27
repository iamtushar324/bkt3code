# External pull-request sync (bkt3 + Linear bridge)

By default T3 Code discovers and refreshes pull requests itself: `ThreadPullRequestReactor` and `PullRequestSyncReactor` sweep every unsettled branch thread each minute with `git` and `gh`. On bkt3 that sweep stalled the event loop for 40–60 s out of every ~110 s and hit GitHub's rate limit about 2,800 times a day.

The fork can hand that job to the Linear bridge instead. The bridge receives GitHub webhooks and posts pull-request state to `POST /api/orchestration/pull-request-state`, and bkt3 stops running the two reactors. The code is in `apps/server/src/orchestration/pullRequestStateHttp.expbkt3.ts` and `externalPullRequestSync.expbkt3.ts`.

Unchanged by the switch:

- PRs an agent creates are still linked immediately (`linkCreatedPullRequest.ts`).
- PR detail panels a user opens still read GitHub.
- `ThreadSettlementReactor` still settles threads on merge, and still makes its own GitHub reads.

## 1. Give the bridge a token with the write scope

The endpoint needs the `external-sync:write` scope. No standard or administrative token carries it. Scopes are fixed when a token is issued, so the bridge needs a new token. On the dev server, with the bkt3 service running:

```bash
node /home/ubuntu/repos/t3code-bkmain/apps/server/dist/bin.mjs auth session issue \
  --base-dir /home/ubuntu/.t3/bkt3-dev \
  --label linear-bridge-external-sync \
  --with-scope external-sync:write \
  --token-only
```

Put the printed token in the bridge's bkt3 token variable (the `tokenEnv` of its bkt3 entry in `bridge-config.json`), then restart the bridge. The token keeps the administrative scopes, so the bridge's existing reads keep working.

To check it, list sessions and confirm the `linear-bridge-external-sync` label:

```bash
node /home/ubuntu/repos/t3code-bkmain/apps/server/dist/bin.mjs auth session list --base-dir /home/ubuntu/.t3/bkt3-dev
```

If bkt3 is rolled back to a build older than the scope, that one session no longer decodes. Issue the bridge a plain token until the build returns.

## 2. Turn off the server-side sweep

Before the switch, confirm that every repository with open branch threads sends webhooks to the bridge.

Then add this line to `deploy/bkt3/start.sh`, next to the other exports:

```bash
export T3_EXTERNAL_PR_SYNC=1
```

Restart `t3-bkmain.service`. The journal logs `pull request reactor not started: external sync owns PR state` once for each reactor.

This restart ends every live session on bkt3, so warn the team first.

**Rollback:** remove the line and restart. The reactors resume on the next start.
