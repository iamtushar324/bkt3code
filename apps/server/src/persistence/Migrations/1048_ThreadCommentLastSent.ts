// T3-CUSTOM(expbkt3): when a review comment last went to the agent. A comment
// goes once; it is sent again only after the user edits, replies to or reopens
// it, or asks for a re-send. Nullable: existing comments count as not sent, so
// each open one goes once more and is then marked.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(thread_comments)
  `;

  if (!columns.some((column) => column.name === "last_sent_at")) {
    yield* sql`
      ALTER TABLE thread_comments
      ADD COLUMN last_sent_at TEXT
    `;
  }
});
