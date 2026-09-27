// T3-CUSTOM(expbkt3): per-thread custom sidebar group. A shared, durable label
// that files the thread under a section of the sidebar's "Custom" grouping
// mode; set from the row menu or by an agent through `t3_update_session`.
// Nullable: an absent label means "ungrouped", which is what every existing
// row is.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "custom_group")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN custom_group TEXT
    `;
  }
});
