// T3-CUSTOM(expbkt3): Claude account profiles per thread.
//
// One row per thread: the chosen mode (auto, or a pinned profile) and the
// account the thread last resolved to, so a resume lands on the same account
// and the prompt cache survives. No foreign key to threads: a draft thread's
// row may be written before the thread itself exists.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_claude_account (
      thread_id TEXT PRIMARY KEY,
      mode_json TEXT NOT NULL,
      resolved_profile TEXT,
      resolved_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
