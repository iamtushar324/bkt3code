// T3-CUSTOM(expbkt3): session lineage. A thread spawned by another session
// (today via the t3_create_session MCP tool) records its parent so the
// experimental sidebar can file it under that session instead of stranding it
// as an unrelated top-level row. NULL means "root session".
//
// The column is intentionally not a foreign key: a parent may be hard-deleted
// while its children live on, and readers already treat an unresolvable parent
// as "render me at the top level".
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "parent_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_thread_id TEXT
    `;
  }

  // Children-of lookups drive the cycle guard on every re-parent, so they must
  // not degrade into a full scan of the thread projection.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_parent_thread_id
    ON projection_threads (parent_thread_id)
    WHERE parent_thread_id IS NOT NULL
  `;
});
