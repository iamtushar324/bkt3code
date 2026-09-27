// T3-CUSTOM(expbkt3): make the startup ownership backfill cheap.
//
// The backfill's correlated subqueries filter orchestration_events on
// event_type and join on stream_id. Every existing index leads with
// aggregate_kind, so those subqueries scanned the whole event log once per
// candidate row. The marker table lets the one-time admin-reassignment repair
// record that it is done instead of re-running on every boot forever.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_event_type_stream
    ON orchestration_events(event_type, stream_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS maintenance_markers (
      marker TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    )
  `;
});
