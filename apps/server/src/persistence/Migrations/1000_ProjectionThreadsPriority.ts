// T3-CUSTOM(expbkt3): session priority (P0..P4) stored as a nullable integer.
// NULL means "unprioritised", 0 is the highest priority.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "priority")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN priority INTEGER
    `;
  }
});
