import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Rolling per-thread summary maintained by CatchupSummaryReactor.
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN rolling_summary TEXT
  `.pipe(Effect.catch(() => Effect.void));

  // Short per-turn catch-up summary, only present for turns that exceeded the
  // configured duration cutoff.
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN catchup_summary TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN catchup_summary_created_at TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
