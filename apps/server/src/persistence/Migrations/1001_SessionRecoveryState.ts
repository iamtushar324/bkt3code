// T3-CUSTOM(expbkt3): backend desired-state for automatic session recovery.
//
// The existing projections cannot express *intent*: a thread sitting at
// turn_state='interrupted' with stop_requested_at IS NULL is produced by a
// provider-side abort, a graceful mid-turn exit, and the startup epoch sweep
// alike — and only the last of those should be reconnected. This table records
// what the user wanted, written at the moment that intent is known.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_recovery_state (
      thread_id TEXT PRIMARY KEY NOT NULL,
      desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped')),
      reason TEXT,
      last_execution_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_at TEXT,
      recovered_at TEXT,
      gave_up_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_session_recovery_desired
    ON session_recovery_state(desired_state)
  `;
});
