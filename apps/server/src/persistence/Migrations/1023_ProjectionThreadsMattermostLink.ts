// T3-CUSTOM(expbkt3): durable Mattermost conversation permalink on a thread.
// Written by the Linear/Mattermost bridge when it binds a session to a
// Mattermost thread, so the sidebar can mark sessions a human is watching
// from chat. Nullable: most threads have no Mattermost conversation.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "mattermost_thread_url")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN mattermost_thread_url TEXT
    `;
  }
});
