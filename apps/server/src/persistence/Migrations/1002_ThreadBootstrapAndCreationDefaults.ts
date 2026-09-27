// T3-CUSTOM(expbkt3): durable worktree bootstrap progress and per-project
// creation defaults. Fork migrations are allocated from 1000 upward.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!projectColumns.some((column) => column.name === "thread_creation_defaults_json")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN thread_creation_defaults_json TEXT NOT NULL
      DEFAULT '{"environmentMode":null,"worktreeBaseRef":null,"runtimeMode":null,"interactionMode":null}'
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_bootstraps (
      thread_id TEXT PRIMARY KEY NOT NULL,
      bootstrap_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'ready')),
      public_state_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_bootstraps_status
    ON projection_thread_bootstraps(status, updated_at)
  `;
});
