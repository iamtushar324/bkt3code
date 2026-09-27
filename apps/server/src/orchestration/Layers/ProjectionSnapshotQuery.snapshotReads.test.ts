import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";

const snapshotQueryLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

snapshotQueryLayer("bounded projection snapshot reads", (it) => {
  it.effect("reads only the newest active plan candidates", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-bounded-read");
      const activeThreadId = ThreadId.make("thread-bounded-active");
      const archivedThreadId = ThreadId.make("thread-bounded-archived");
      const implementedThreadId = ThreadId.make("thread-bounded-implemented");

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          ${projectId},
          'Bounded project',
          '/tmp/bounded-project',
          '{"provider":"codex","model":"gpt-5.6-sol"}',
          '[]',
          '2026-08-05T00:00:00.000Z',
          '2026-08-05T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          rolling_summary,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        ) VALUES
          (
            ${activeThreadId},
            ${projectId},
            'Active thread',
            '{"provider":"codex","model":"gpt-5.6-sol"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-active-new',
            'active rolling summary',
            '2026-08-05T00:00:00.000Z',
            '2026-08-05T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            ${implementedThreadId},
            ${projectId},
            'Implemented-plan thread',
            '{"provider":"codex","model":"gpt-5.6-sol"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            '2026-08-05T00:00:00.000Z',
            '2026-08-05T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            ${archivedThreadId},
            ${projectId},
            'Archived thread',
            '{"provider":"codex","model":"gpt-5.6-sol"}',
            'full-access',
            'default',
            NULL,
            NULL,
            'turn-archived',
            'archived rolling summary',
            '2026-08-05T00:00:00.000Z',
            '2026-08-05T00:00:03.000Z',
            '2026-08-05T00:00:04.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          assistant_message_id,
          state,
          requested_at,
          completed_at,
          checkpoint_files_json,
          catchup_summary,
          catchup_summary_status,
          catchup_summary_created_at
        ) VALUES
          (
            ${activeThreadId},
            'turn-active-old',
            'message-active-old',
            'completed',
            '2026-08-05T00:00:00.000Z',
            '2026-08-05T00:00:01.000Z',
            '[]',
            'old summary',
            'ready',
            '2026-08-05T00:00:01.000Z'
          ),
          (
            ${activeThreadId},
            'turn-active-new',
            'message-active-new',
            'completed',
            '2026-08-05T00:00:01.000Z',
            '2026-08-05T00:00:02.000Z',
            '[]',
            'new summary',
            'ready',
            '2026-08-05T00:00:02.000Z'
          ),
          (
            ${archivedThreadId},
            'turn-archived',
            NULL,
            'completed',
            '2026-08-05T00:00:01.000Z',
            '2026-08-05T00:00:02.000Z',
            '[]',
            NULL,
            'error',
            '2026-08-05T00:00:02.000Z'
          )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        ) VALUES
          (
            'plan-active-old',
            ${activeThreadId},
            'turn-active-old',
            '# Old plan',
            NULL,
            NULL,
            '2026-08-05T00:00:00.000Z',
            '2026-08-05T00:00:00.000Z'
          ),
          (
            'plan-active-new',
            ${activeThreadId},
            'turn-active-new',
            '# New plan',
            NULL,
            NULL,
            '2026-08-05T00:00:01.000Z',
            '2026-08-05T00:00:02.000Z'
          ),
          (
            'plan-implemented-old',
            ${implementedThreadId},
            NULL,
            '# Historical unimplemented plan',
            NULL,
            NULL,
            '2026-08-05T00:00:00.000Z',
            '2026-08-05T00:00:00.000Z'
          ),
          (
            'plan-implemented-new',
            ${implementedThreadId},
            NULL,
            '# Implemented latest plan',
            '2026-08-05T00:00:03.000Z',
            ${activeThreadId},
            '2026-08-05T00:00:01.000Z',
            '2026-08-05T00:00:02.000Z'
          ),
          (
            'plan-archived',
            ${archivedThreadId},
            'turn-archived',
            '# Archived plan',
            NULL,
            NULL,
            '2026-08-05T00:00:01.000Z',
            '2026-08-05T00:00:02.000Z'
          )
      `;

      // If either narrow method hydrates activity history, JSON decoding fails.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        ) VALUES (
          'activity-invalid-json',
          ${activeThreadId},
          'info',
          'test',
          'must not hydrate',
          '{not valid json',
          '2026-08-05T00:00:03.000Z'
        )
      `;

      const candidates = yield* query.listLatestProposedPlansForActiveThreads();
      expect(candidates).toEqual([
        {
          threadId: activeThreadId,
          proposedPlan: {
            id: "plan-active-new",
            turnId: "turn-active-new",
            planMarkdown: "# New plan",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-08-05T00:00:01.000Z",
            updatedAt: "2026-08-05T00:00:02.000Z",
          },
        },
      ]);
    }),
  );
});
