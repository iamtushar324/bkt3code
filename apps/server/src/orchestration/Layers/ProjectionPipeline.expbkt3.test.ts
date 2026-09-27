import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-projection-hot-path-expbkt3-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("ProjectionPipeline expbkt3 hot paths", (it) => {
  it.effect("projects unrelated activity without hydrating historical activity payloads", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("project-projection-hot-path");
      const threadId = ThreadId.make("thread-projection-hot-path");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-projection-hot-path-project"),
        projectId,
        title: "Projection hot path",
        workspaceRoot: "/tmp/project-projection-hot-path",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt: "2026-08-03T16:30:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-projection-hot-path-thread"),
        threadId,
        projectId,
        title: "Projection hot path thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        sourceControlProfileId: null,
        createdAt: "2026-08-03T16:30:01.000Z",
      });

      // Historical rows can outlive the schema version that created them. An
      // unrelated activity append must not decode the entire activity body.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES (
          'activity-projection-hot-path-historical',
          ${threadId},
          NULL,
          'info',
          'tool.completed',
          'Historical activity',
          '{invalid historical json',
          NULL,
          '2026-08-03T16:30:02.000Z'
        )
      `;

      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-projection-hot-path-activity"),
        threadId,
        activity: {
          id: EventId.make("activity-projection-hot-path-current"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Async question",
          payload: { requestId: "async-question", questions: [], responseMode: "message" },
          turnId: null,
          createdAt: "2026-08-03T16:30:03.000Z",
        },
        createdAt: "2026-08-03T16:30:03.000Z",
      });

      const shell = yield* snapshotQuery.getThreadShellById(threadId);
      assert.isTrue(Option.isSome(shell));
      const projectedShell = Option.getOrThrow(shell);
      assert.equal(projectedShell.updatedAt, "2026-08-03T16:30:03.000Z");
      assert.isFalse(projectedShell.hasPendingApprovals);
      assert.isFalse(projectedShell.hasPendingUserInput);
      assert.isTrue(projectedShell.hasPendingAsyncUserInput);
    }),
  );
});
