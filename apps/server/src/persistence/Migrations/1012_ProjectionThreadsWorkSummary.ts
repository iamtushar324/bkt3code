/**
 * T3-CUSTOM(expbkt3): durable bulk-session-manager work summary on a thread.
 *
 * One JSON-encoded `ThreadWorkSummary` per thread. NULL means the summary was
 * never generated, which is distinct from a generated-but-empty result.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "work_summary")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN work_summary TEXT
    `;
  }
});
