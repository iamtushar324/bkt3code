// T3-CUSTOM(expbkt3): the durable revive queue for Claude account placement.
//
// A thread that no account can take waits in `thread_claude_account` until
// the status poll finds room. All four columns are null for a thread that is
// not waiting:
//
// - `wait_queued_at`: when it joined the queue (oldest goes first);
// - `wait_was_active`: 1 when a turn was in flight, so the revive sends the
//   continue turn; 0 when it wakes only once someone writes;
// - `wait_prefer_profile`: the account a short reset wait continues on;
// - `wait_not_before`: the time that wait ends.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(thread_claude_account)`;
  const present = new Set(columns.map((column) => column.name));
  if (!present.has("wait_queued_at")) {
    yield* sql`ALTER TABLE thread_claude_account ADD COLUMN wait_queued_at TEXT`;
  }
  if (!present.has("wait_was_active")) {
    yield* sql`ALTER TABLE thread_claude_account ADD COLUMN wait_was_active INTEGER`;
  }
  if (!present.has("wait_prefer_profile")) {
    yield* sql`ALTER TABLE thread_claude_account ADD COLUMN wait_prefer_profile TEXT`;
  }
  if (!present.has("wait_not_before")) {
    yield* sql`ALTER TABLE thread_claude_account ADD COLUMN wait_not_before TEXT`;
  }
});
