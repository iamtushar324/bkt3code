import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("getThreadDetailSnapshot archived early exit", (it) => {
  it.effect("answers an archived, deleted or missing thread without the detail read", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* ProjectionSnapshotQuery;

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

      const statementsFor = (id: string, window?: { readonly turnLimit: number }) =>
        Effect.gen(function* () {
          const counter = makeSqlStatementCounter();
          const snapshot = yield* snapshots
            .getThreadDetailSnapshot(ThreadId.make(id), window)
            .pipe(Effect.withTracer(counter.tracer));
          return { found: Option.isSome(snapshot), statements: counter.count() };
        });

      // Both read shapes the HTTP and WebSocket routes serve.
      for (const window of [{ turnLimit: 20 }, undefined]) {
        const active = yield* statementsFor("thread-active", window);
        assert.isTrue(active.found);
        for (const id of ["thread-archived", "thread-deleted", "thread-missing"]) {
          const gone = yield* statementsFor(id, window);
          assert.isFalse(gone.found, id);
          // One row lookup instead of every detail list.
          assert.strictEqual(gone.statements, 1, id);
          assert.isAbove(active.statements, gone.statements + 3, id);
        }
      }
    }),
  );
});
