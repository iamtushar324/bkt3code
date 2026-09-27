// T3-CUSTOM(expbkt3): cross-environment session lineage. A thread can now name a
// parent that lives on a different machine — a child started locally under a
// session on a remote host, or work deliberately spread across several hosts.
//
// The parent link was a bare thread id, which is only unambiguous within one
// server. This records the environment that id belongs to alongside it. NULL
// means "the same environment as this thread", which is what every existing row
// means and what every caller that knows nothing about this column will keep
// producing, so nothing has to be backfilled.
//
// Like parent_thread_id, this is deliberately not a foreign key: the identified
// environment belongs to another server this one has never spoken to, and an
// unresolvable parent already renders at the top level.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "parent_environment_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN parent_environment_id TEXT
    `;
  }
});
