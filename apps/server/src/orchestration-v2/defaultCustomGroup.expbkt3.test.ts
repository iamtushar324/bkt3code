// T3-CUSTOM(expbkt3): the group a new session joins when its creator names none.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters } from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const registry = layerFromAdapters([
  {
    instanceId: providerInstanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("Provider execution is outside this test."),
  },
]);

const create = (threadId: ThreadId) => ({
  type: "thread.create" as const,
  commandId: CommandId.make(`create:${threadId}`),
  createdBy: "user" as const,
  creationSource: "web" as const,
  threadId,
  projectId: ProjectId.make("project:default-group"),
  title: "Session",
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
});

it.layer(
  layerWithRegistry({ name: "default-custom-group" }, registry, {
    runEffectWorker: false,
    serverSettings: {
      threadCustomGroups: { backlog: { label: "Backlog" }, ops: { label: "Ops" } },
      defaultThreadCustomGroup: "BACKLOG",
    },
  }),
)("default custom group for new sessions", (it) => {
  it.effect("puts a top-level session in the default group, in the registry's spelling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("default-group:top");
      yield* orchestrator.dispatch(create(threadId));
      const thread = yield* orchestrator.getThreadShell(threadId);
      assert.equal(thread?.customGroup, "Backlog");
    }),
  );

  it.effect("keeps a group the creator named, and an explicit null", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const named = ThreadId.make("default-group:named");
      const ungrouped = ThreadId.make("default-group:ungrouped");
      yield* orchestrator.dispatch({ ...create(named), customGroup: "Ops" });
      yield* orchestrator.dispatch({ ...create(ungrouped), customGroup: null });
      assert.equal((yield* orchestrator.getThreadShell(named))?.customGroup, "Ops");
      assert.equal((yield* orchestrator.getThreadShell(ungrouped))?.customGroup ?? null, null);
    }),
  );

  it.effect("puts a child in its parent's group, not the default", () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const parentId = ThreadId.make("default-group:parent");
      const childId = ThreadId.make("default-group:child");
      const orphanId = ThreadId.make("default-group:orphan");
      yield* orchestrator.dispatch({ ...create(parentId), customGroup: "Ops" });
      yield* orchestrator.dispatch({ ...create(childId), parentThreadId: parentId });
      yield* orchestrator.dispatch({
        ...create(orphanId),
        parentThreadId: ThreadId.make("default-group:not-on-this-host"),
      });
      assert.equal((yield* orchestrator.getThreadShell(childId))?.customGroup, "Ops");
      assert.equal((yield* orchestrator.getThreadShell(orphanId))?.customGroup ?? null, null);
    }),
  );
});
