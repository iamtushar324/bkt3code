/**
 * T3-CUSTOM(expbkt3): keep SQLite's query-planner statistics fresh.
 *
 * Prod bkt3 had never been analysed (no `sqlite_stat1`), so the planner picked
 * among overlapping indexes without statistics. Every 6 h this runs SQLite's
 * recipe for long-lived connections, `PRAGMA optimize=0x10002` with
 * `analysis_limit=400`, which analyses only tables whose statistics are
 * missing or stale and samples at most ~400 rows per index.
 *
 * It never runs at startup: node:sqlite is synchronous, so even a parked fiber
 * blocks the event loop, and the first-ever run took 2.8 s on a copy of the
 * 7.6 GB prod database (later runs: ~0 ms). The first run therefore lands 6 h
 * after a deploy, once. `T3_SQLITE_OPTIMIZE=0` turns it off, in case fresh
 * statistics ever flip a query plan the wrong way.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";

export const SQLITE_OPTIMIZE_INTERVAL = Duration.hours(6);
export const SQLITE_OPTIMIZE_ENV = "T3_SQLITE_OPTIMIZE";

export const sqliteOptimizeEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
  const value = env[SQLITE_OPTIMIZE_ENV]?.trim().toLowerCase();
  return !(value === "0" || value === "false" || value === "off" || value === "no");
};

export const runSqliteOptimize = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const startedAt = yield* Clock.currentTimeMillis;
  yield* sql`PRAGMA analysis_limit = 400`;
  yield* sql`PRAGMA optimize = 0x10002`;
  yield* Effect.logInfo("sqlite.optimize.finished", {
    durationMs: (yield* Clock.currentTimeMillis) - startedAt,
  });
});

/** Server-only: forks the 6-hourly optimize for the life of the server. */
export const SqliteOptimizeScheduleLive = Layer.effectDiscard(
  Effect.gen(function* () {
    if (!sqliteOptimizeEnabled()) {
      yield* Effect.logInfo("sqlite.optimize.disabled", { env: SQLITE_OPTIMIZE_ENV });
      return;
    }
    const sql = yield* SqlClient.SqlClient;
    const runOnce = runSqliteOptimize.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catch((error) => Effect.logWarning("sqlite.optimize.failed", { error })),
      Effect.catchDefect((defect) => Effect.logWarning("sqlite.optimize.defect", { defect })),
    );
    yield* forkParked(
      Effect.sleep(SQLITE_OPTIMIZE_INTERVAL).pipe(Effect.andThen(runOnce), Effect.forever),
    );
  }),
);
