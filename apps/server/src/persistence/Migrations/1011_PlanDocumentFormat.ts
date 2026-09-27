// T3-CUSTOM(expbkt3): plan documents remember whether they are markdown or HTML.
//
// Providers put the whole plan in `planMarkdown` even when its value is an HTML
// document, so the renderer has to be recorded rather than re-sniffed on every
// read. Existing rows are markdown — the HTML path did not exist before this.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(plan_documents)
  `;

  if (!columns.some((column) => column.name === "format")) {
    yield* sql`
      ALTER TABLE plan_documents
      ADD COLUMN format TEXT NOT NULL DEFAULT 'md'
    `;
  }
});
