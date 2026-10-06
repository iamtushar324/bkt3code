// T3-CUSTOM(expbkt3): new thread members receive their project before the live thread delta.
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import { filterNativeShellStream } from "./wsV2Visibility.expbkt3.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const registry = Layer.mock(ProviderAdapterRegistryV2)({
  get: () => Effect.die("Provider execution is outside this visibility test."),
  list: () => Effect.succeed([providerInstanceId]),
});
const TestLayer = ProviderReplayHarness.layerWithRegistry(
  { name: "live-member-visibility" },
  registry,
  { runEffectWorker: false },
);

it.effect(
  "delivers the hidden parent project before a newly shared thread and removes a revoked thread",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const actor = UserId.make("user:member");
      const owner = UserId.make("user:owner");
      const threadId = ThreadId.make("thread:shared");
      const projectId = ProjectId.make("project:fork");
      yield* orchestrator.dispatch(
        {
          type: "thread.create",
          commandId: CommandId.make("create:shared"),
          threadId,
          projectId,
          title: "Shared thread",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          memberUserIds: [actor],
        },
        { actorUserId: owner },
      );
      const shell = yield* orchestrator.getThreadShell(threadId);
      if (shell === null) return yield* Effect.die("The created thread must have a shell.");
      let projectReads = 0;
      const project = {
        id: projectId,
        title: "Hidden project",
        workspaceRoot: "/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-03T00:00:00Z",
        ownerUserId: owner,
      };
      const access = {
        actorFor: () => Option.none(),
        canAccessThread: () => Effect.succeed(true),
        canAccessProject: () => Effect.succeed(false),
        canTransferThreadOwnership: () => Effect.succeed(false),
        canTransferProjectOwnership: () => Effect.succeed(false),
      };
      const events = yield* filterNativeShellStream(
        Stream.make(
          {
            kind: "thread.updated" as const,
            sequence: 1,
            location: "active" as const,
            thread: shell,
          },
          {
            kind: "thread.updated" as const,
            sequence: 2,
            location: "active" as const,
            thread: { ...shell, title: "Updated thread" },
          },
          {
            kind: "thread.updated" as const,
            sequence: 3,
            location: "active" as const,
            thread: { ...shell, memberUserIds: [] },
          },
        ),
        actor,
        access,
        {
          getShell: () =>
            Effect.sync(() => {
              projectReads += 1;
              return Option.some(project);
            }),
        },
      ).pipe(Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event.kind),
        ["project.updated", "thread.updated", "thread.updated", "thread.removed"],
      );
      assert.deepEqual(
        events.map((event) => ("sequence" in event ? event.sequence : null)),
        [1, 1, 2, 3],
      );
      assert.equal(projectReads, 1);
    }).pipe(Effect.provide(TestLayer)),
);
