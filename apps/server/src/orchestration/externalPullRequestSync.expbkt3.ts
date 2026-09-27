/**
 * T3-CUSTOM(expbkt3): `T3_EXTERNAL_PR_SYNC=1` hands pull-request discovery and
 * sync to an external syncer (the Linear bridge, fed by GitHub webhooks).
 *
 * The upstream `ThreadPullRequestReactor` and `PullRequestSyncReactor` sweep
 * every unsettled branch thread each minute with git and `gh`; on bkt3 that
 * stalled the event loop for 40-60 s of every ~110 s and hit GitHub's rate
 * limit ~2,800 times a day. With the switch on they are not started, and PR
 * state arrives through `POST /api/orchestration/pull-request-state` instead.
 * Unset keeps upstream behaviour. Rollback is unsetting it and restarting.
 */
import * as Effect from "effect/Effect";

export const EXTERNAL_PR_SYNC_ENV = "T3_EXTERNAL_PR_SYNC";

export const externalPullRequestSyncEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const value = env[EXTERNAL_PR_SYNC_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
};

/** Runs `start` unless an external syncer owns pull-request state. */
export const unlessExternalPullRequestSync = <E, R>(
  reactor: string,
  start: Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.suspend(() =>
    externalPullRequestSyncEnabled()
      ? Effect.logInfo("pull request reactor not started: external sync owns PR state", {
          reactor,
          env: EXTERNAL_PR_SYNC_ENV,
        })
      : start,
  );
