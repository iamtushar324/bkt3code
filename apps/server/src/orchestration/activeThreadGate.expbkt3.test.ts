import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeActiveThreadCheck } from "./activeThreadGate.expbkt3.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("makeActiveThreadCheck", (it) => {
  it.effect("agrees with getThreadDetailSnapshot on which threads exist", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* ProjectionSnapshotQuery;
      const isActiveThread = yield* makeActiveThreadCheck;

      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at)
        VALUES
          ('project-1', 'Project', '/tmp/project-1', '{"provider":"codex","model":"gpt-5-codex"}', '[]',
           '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO projection_threads
          (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
           created_at, updated_at, archived_at, deleted_at)
        VALUES
          ('thread-active', 'project-1', 'Active', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL, NULL),
          ('thread-archived', 'project-1', 'Archived', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
           '2026-10-01T01:00:00.000Z', NULL),
          ('thread-deleted', 'project-1', 'Deleted', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
           NULL, '2026-10-01T01:00:00.000Z')
      `;

      const expected = {
        "thread-active": true,
        "thread-archived": false,
        "thread-deleted": false,
        "thread-missing": false,
      };
      for (const [id, found] of Object.entries(expected)) {
        const threadId = ThreadId.make(id);
        assert.strictEqual(yield* isActiveThread(threadId), found, id);
        // The gate stands in front of both read shapes the HTTP route serves.
        assert.strictEqual(
          Option.isSome(yield* snapshots.getThreadDetailSnapshot(threadId, { turnLimit: 20 })),
          found,
          `${id} (windowed)`,
        );
        assert.strictEqual(
          Option.isSome(yield* snapshots.getThreadDetailSnapshot(threadId)),
          found,
          `${id} (full)`,
        );
      }
    }),
  );
});
