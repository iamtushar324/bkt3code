// T3-CUSTOM(expbkt3): BK sidebar custom group for the fresh threads a scheduled
// task launches (XFN-59). A fork-owned side table keyed by task id, so
// upstream's scheduled_tasks schema, upsert and web editor stay untouched.
//
// No foreign key on purpose: with `foreign_keys = ON`, an upstream migration
// that rebuilds scheduled_tasks (create, copy, drop, rename) would cascade the
// drop into every label. Writes land only while their task exists, and a task
// delete removes its label in the same transaction instead.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_custom_groups (
      task_id TEXT PRIMARY KEY,
      custom_group TEXT NOT NULL
    )
  `;
});
