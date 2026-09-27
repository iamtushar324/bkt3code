// T3-CUSTOM(expbkt3): agent-rendered UI surfaces shown inline in chat.
//
// One row per `t3_show_ui` call. Rows are insert-only: an agent re-running the
// tool produces a new render rather than mutating an old one, so a timeline row
// keeps showing what the agent actually produced at that point in the thread.
// Bodies live here instead of on the activity payload, which is capped.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_ui_renders (
      render_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      html TEXT,
      url TEXT,
      height INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // Thread-scoped reads back the fetch-on-demand RPC, and the archive sweep
  // deletes by thread.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_ui_renders_thread
      ON agent_ui_renders(thread_id, created_at)
  `;
});
