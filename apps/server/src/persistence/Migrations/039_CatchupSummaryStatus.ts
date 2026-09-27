import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // "pending" while the summarizer runs, "ready" once text exists. Rows written
  // before this migration always carry text, so they backfill as "ready".
  yield* sql`
    ALTER TABLE projection_turns
    ADD COLUMN catchup_summary_status TEXT
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE projection_turns
    SET catchup_summary_status = 'ready'
    WHERE catchup_summary IS NOT NULL
      AND catchup_summary_status IS NULL
  `.pipe(Effect.catch(() => Effect.void));
});
