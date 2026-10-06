// T3-CUSTOM(expbkt3): review comments on assistant messages in the main chat.
//
// One row per comment; replies ride along as a JSON array because a comment
// caps them and always reads them together. The per-thread settings row holds
// the "delivery paused" switch and the next display number, so numbering stays
// monotonic even after a comment is removed.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_comments (
      comment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      anchor_json TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      author_user_id TEXT,
      author_label TEXT,
      replies_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;

  // Every read is per thread: the sidebar snapshot, the turn-start injection,
  // and the MCP listing.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_comments_thread
      ON thread_comments(thread_id, number)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_comment_settings (
      thread_id TEXT PRIMARY KEY,
      delivery_paused INTEGER NOT NULL DEFAULT 0,
      next_number INTEGER NOT NULL DEFAULT 1
    )
  `;
});
