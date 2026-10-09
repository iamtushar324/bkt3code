// T3-CUSTOM(expbkt3): create_threads files new threads under a BK sidebar custom group (XFN-59).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpUpdateScheduledTaskInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  THREAD_CUSTOM_GROUP_MAX_LENGTH,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { ProviderAdapterV2Shape } from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const decodeCreateThreads = Schema.decodeUnknownOption(OrchestratorMcpCreateThreadsInput);
const decodeScheduleTask = Schema.decodeUnknownOption(OrchestratorMcpScheduleTaskInput);
const decodeUpdateScheduledTask = Schema.decodeUnknownOption(
  OrchestratorMcpUpdateScheduledTaskInput,
);

describe("OrchestratorMcpService custom groups", () => {
  const parentThreadId = ThreadId.make("thread:mcp-custom-group-parent");
  const parentRunId = RunId.make("run:mcp-custom-group-parent");
  const parentNodeId = NodeId.make("node:mcp-custom-group-root");
  const projectId = ProjectId.make("project:mcp-custom-group");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const modelSelection = { instanceId: codexInstanceId, model: "gpt-5.4" } as const;

  const scope: McpInvocationScope = {
    principal: "provider-session",
    actorUserId: null,
    environmentId: EnvironmentId.make("environment:mcp-custom-group"),
    requestNamespace: "provider-session:mcp-custom-group",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-custom-group",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const codexProvider: ServerProvider = {
    instanceId: codexInstanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-09T00:00:00.000Z",
    models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };

  const parentProjection = {
    thread: {
      id: parentThreadId,
      projectId,
      title: "MCP parent",
      createdBy: "user",
      creationSource: "web",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/custom-groups",
      worktreePath: null,
    },
    runs: [
      {
        id: parentRunId,
        ordinal: 1,
        status: "running",
        rootNodeId: parentNodeId,
        providerInstanceId: codexInstanceId,
        modelSelection,
      },
    ],
    contextTransfers: [],
    subagents: [],
  } as unknown as OrchestrationV2ThreadProjection;

  const createdProjection = (threadId: ThreadId) =>
    ({
      thread: { id: threadId, title: "Created", createdBy: "agent", creationSource: "mcp" },
      runs: [],
      contextTransfers: [],
      messages: [],
      subagents: [],
      providerThreads: [],
      turnItems: [],
    }) as unknown as OrchestrationV2ThreadProjection;

  it.effect("passes each entry's custom group to the thread it creates", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection : createdProjection(threadId),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codexProvider]),
          refreshInstance: () => Effect.succeed([codexProvider]),
        }),
        Layer.succeed(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
            list: () => Effect.succeed([codexInstanceId]),
            get: (instanceId) =>
              Effect.succeed({ instanceId } as unknown as ProviderAdapterV2Shape),
          }),
        ),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      const result = yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.createThreads(scope, {
          threads: [{ title: "Grouped", customGroup: "Nightly checks" }, { title: "Ungrouped" }],
          clientRequestId: "custom-group-threads",
        });
      }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(layerDependencies))));

      assert.equal(result.threads.length, 2);
      const creates = (
        (yield* Ref.get(dispatched)) as ReadonlyArray<{
          readonly type: string;
          readonly customGroup?: unknown;
        }>
      ).filter((command) => command.type === "thread.create");
      assert.deepEqual(
        creates.map((command) => command.customGroup),
        ["Nightly checks", undefined],
      );
      assert.isFalse("customGroup" in creates[1]!);
    }),
  );

  it("validates customGroup with the shared sidebar label schema", () => {
    const entry = (customGroup: string) =>
      decodeCreateThreads({ threads: [{ title: "Grouped", customGroup }] });
    assert.deepEqual(
      Option.map(entry("  Nightly checks  "), (input) => input.threads[0]?.customGroup),
      Option.some("Nightly checks"),
    );
    assert.isTrue(Option.isNone(entry("   ")));
    assert.isTrue(Option.isNone(entry("x".repeat(THREAD_CUSTOM_GROUP_MAX_LENGTH + 1))));

    const schedule = {
      projectId,
      prompt: "Check the nightly build.",
      schedule: { type: "interval", everyMs: 3_600_000 },
    };
    assert.deepEqual(
      Option.map(
        decodeScheduleTask({ ...schedule, customGroup: "Nightly checks" }),
        (input) => input.customGroup,
      ),
      Option.some("Nightly checks"),
    );
    // Only an update may remove the label, with null.
    assert.isTrue(Option.isNone(decodeScheduleTask({ ...schedule, customGroup: null })));
    assert.deepEqual(
      Option.map(
        decodeUpdateScheduledTask({ scheduledTaskId: "scheduled-task:nightly", customGroup: null }),
        (input) => input.customGroup,
      ),
      Option.some(null),
    );
  });
});
