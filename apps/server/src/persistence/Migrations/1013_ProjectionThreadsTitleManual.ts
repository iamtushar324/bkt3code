/**
 * T3-CUSTOM(expbkt3): durable record that a human named a session.
 *
 * Generated renames (first-turn naming, the periodic refresh) must never
 * replace a title someone typed. Nothing in the projection distinguished the
 * two, so the refresh cadence used to stomp manual renames.
 *
 * Backfilled to 0 for every existing row: an old title may well be hand-typed,
 * but the cadence has always overwritten those, so defaulting to "generated"
 * preserves today's behavior rather than silently freezing old sessions. The
 * next rename records the truth.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "title_manually_set")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_manually_set INTEGER NOT NULL DEFAULT 0
    `;
  }
});
