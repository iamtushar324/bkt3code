// T3-CUSTOM(expbkt3): one worktree per (parent session, repository).
//
// A session that fans work out into another repository should reuse one
// worktree for every child it puts there, rather than one per child. The group
// row is the reservation: whichever child claims (owner_thread_id, project_id)
// first records the branch and path it allocated, and every later child of that
// parent in that repository joins it.
//
// The reservation is written at accept time, before `git worktree add` runs,
// because a parallel fan-out dispatches every child before any of them has a
// worktree to be observed. `ready` records that the worktree now exists on disk,
// so a joiner can skip creation instead of racing its sibling for it.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_workspace_groups (
      owner_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      ready INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (owner_thread_id, project_id)
    )
  `;
});
