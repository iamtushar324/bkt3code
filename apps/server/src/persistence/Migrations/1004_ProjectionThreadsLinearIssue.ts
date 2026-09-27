// T3-CUSTOM(expbkt3): durable manual Linear issue URL on a thread.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "linear_issue_url")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN linear_issue_url TEXT
    `;
  }
});
