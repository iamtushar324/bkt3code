// T3-CUSTOM(expbkt3): archive export, MCP archive lists and event visibility read archived shells here.
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { makeForkCompatibilityTestLayer } from "./testkit/ForkCompatibility.expbkt3.ts";

const layer = makeForkCompatibilityTestLayer("archivedShellSnapshot.expbkt3.test.ts").pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-archived-shell-" })),
  Layer.provideMerge(NodeServices.layer),
);

const createThread = (id: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-${id}`),
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project-archive"),
      title: id,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      sourceControlProfileId: null,
      createdAt: "2026-10-05T00:00:00.000Z",
    });
  });

it.layer(layer)("archived shell snapshot", (it) => {
  it.effect("lists archived threads and only archived threads", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive"),
        projectId: ProjectId.make("project-archive"),
        title: "project-archive",
        workspaceRoot: process.cwd(),
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt: "2026-10-05T00:00:00.000Z",
      });
      yield* createThread("thread-active");
      yield* createThread("thread-archived");
      yield* engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-archive"),
        threadId: ThreadId.make("thread-archived"),
      });

      const snapshots = yield* ProjectionSnapshotQuery;
      const archived = yield* snapshots.getArchivedShellSnapshot();
      const active = yield* snapshots.getShellSnapshot();

      assert.deepEqual(
        archived.threads.map((thread) => thread.id),
        ["thread-archived"],
      );
      assert.isNotNull(archived.threads[0]?.archivedAt);
      assert.deepEqual(
        active.threads.map((thread) => thread.id),
        ["thread-active"],
      );
    }),
  );
});
