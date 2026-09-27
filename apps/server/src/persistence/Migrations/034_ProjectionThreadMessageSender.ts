import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Records the Clerk user who sent each user message (team mode), so multi-
 * collaborator threads can attribute messages to their author. Null for
 * assistant/system messages and single-user mode.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_thread_messages
    ADD COLUMN sent_by_user_id TEXT
  `.pipe(Effect.catch(() => Effect.void));
});
