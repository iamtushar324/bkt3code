// T3-CUSTOM(expbkt3): the BK options of a scheduled task that upstream's task
// row has no field for: who a run acts for, who it tags, how loud a new
// session is, and whether the task runs only once. A fork-owned side table
// keyed by task id, like scheduled_task_custom_groups (1051), and for the same
// reason without a foreign key: a task delete removes its options in the same
// transaction instead.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_fork_options (
      task_id TEXT PRIMARY KEY,
      options_json TEXT NOT NULL
    )
  `;
});
