import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Durable, backend-authoritative execution snapshots. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_executions (
      thread_id TEXT PRIMARY KEY NOT NULL,
      authority_epoch TEXT NOT NULL,
      revision INTEGER NOT NULL,
      observed_at TEXT NOT NULL,
      activity TEXT NOT NULL,
      can_stop INTEGER NOT NULL,
      provider_session_state TEXT NOT NULL,
      provider_generation INTEGER NOT NULL,
      provider_instance_id TEXT,
      provider_started_at TEXT,
      provider_last_observed_at TEXT,
      provider_last_error TEXT,
      execution_id TEXT,
      provider_turn_id TEXT,
      turn_state TEXT,
      turn_started_at TEXT,
      stop_requested_at TEXT,
      turn_completed_at TEXT,
      turn_last_error TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_executions_activity
    ON projection_thread_executions(activity)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_executions_epoch
    ON projection_thread_executions(authority_epoch)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_execution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      authority_epoch TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      execution_id TEXT,
      activity TEXT NOT NULL,
      turn_state TEXT,
      error TEXT,
      occurred_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_execution_events_thread_revision
    ON thread_execution_events(thread_id, authority_epoch, revision)
  `;
});
