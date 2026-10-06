// T3-CUSTOM(expbkt3): archive-time export resolves the archived session it was handed.
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { makeForkCompatibilityTestLayer } from "../orchestration-v2/testkit/ForkCompatibility.expbkt3.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SessionArchive from "./SessionArchiveService.ts";

const platform = ServerConfig.layerTest(process.cwd(), { prefix: "t3-archive-export-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const engine = makeForkCompatibilityTestLayer("exportHistory.expbkt3.test.ts").pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const layer = SessionArchive.layer.pipe(
  Layer.provideMerge(engine),
  Layer.provideMerge(
    ServerSettings.layerTest({ experimental: { sessionArchive: { enabled: true } } }),
  ),
  // Worktree removal is reclaim-only; export never reaches it.
  Layer.provideMerge(Layer.mock(GitWorkflowService)({})),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(platform),
);

const createThread = (id: string) =>
  Effect.gen(function* () {
    const orchestration = yield* OrchestrationEngineService;
    yield* orchestration.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-${id}`),
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project-export"),
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

it.layer(layer)("session archive export", (it) => {
  it.effect("exports an archived session and refuses an active one", () =>
    Effect.gen(function* () {
      const orchestration = yield* OrchestrationEngineService;
      yield* orchestration.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-export"),
        projectId: ProjectId.make("project-export"),
        title: "project-export",
        workspaceRoot: process.cwd(),
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt: "2026-10-05T00:00:00.000Z",
      });
      yield* createThread("thread-active");
      yield* createThread("thread-archived");
      yield* orchestration.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-archive"),
        threadId: ThreadId.make("thread-archived"),
      });

      const archive = yield* SessionArchive.SessionArchiveService;
      const result = yield* archive.exportHistory([
        ThreadId.make("thread-archived"),
        ThreadId.make("thread-active"),
      ]);

      assert.deepEqual(
        result.exported.map((file) => file.threadId),
        ["thread-archived"],
      );
      const fs = yield* FileSystem.FileSystem;
      assert.isTrue(yield* fs.exists(result.exported[0]!.digestPath));
      assert.include(result.exported[0]!.digestPath, "project-export");
      assert.deepEqual(result.failures, [
        { threadId: ThreadId.make("thread-active"), message: "No archived session with this id." },
      ]);
    }),
  );
});
