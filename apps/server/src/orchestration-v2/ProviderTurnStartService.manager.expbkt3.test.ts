// T3-CUSTOM(expbkt3): execute the real V2 start path with only provider boundaries replaced.
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  UserId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { isActiveExternalGrant } from "../mcp/UserMcpProfileStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

vi.mock("../mcp/UserMcpProfileStore.ts", () => ({ isActiveExternalGrant: vi.fn() }));

function fixture(
  options: {
    text?: string;
    background?: boolean;
    deny?: "grant" | "member" | "settings";
    revokeAt?: "open" | "send";
  } = {},
) {
  const now = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
  const threadId = ThreadId.make("managed-thread");
  const runId = RunId.make("managed-run");
  const actor = UserId.make("original-actor");
  const rootNodeId = NodeId.make("managed-root");
  const attemptId = RunAttemptId.make("managed-attempt");
  const providerThreadId = ProviderThreadId.make("managed-provider-thread");
  const providerSessionId = ProviderSessionId.make("managed-provider-session");
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const messageId = MessageId.make("managed-message");
  const scopeId = CheckpointScopeId.make("managed-scope");
  let grantActive = options.deny !== "grant";
  vi.mocked(isActiveExternalGrant).mockImplementation((user, hash) =>
    Effect.succeed(grantActive && user === actor && hash === "original-grant"),
  );
  const providerThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  } as OrchestrationV2ThreadProjection["providerThreads"][number];
  let projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      branch: null,
      worktreePath: null,
      ownerUserId: UserId.make("different-owner"),
      memberUserIds: options.deny === "member" ? [] : [actor],
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        rootNodeId,
        checkpointScopeId: scopeId,
        parentNodeId: null,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        startedAt: null,
        completedAt: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        sentByUserId: actor,
        ...(options.background === false ? {} : { backgroundGrantHash: "original-grant" }),
        text: options.text ?? "Continue approved work",
        attachments: [],
        streaming: false,
        createdBy: "agent",
        creationSource: "server",
        createdAt: now,
        updatedAt: now,
      },
    ],
    providerThreads: [providerThread],
    providerSessions: [],
    providerTurns: [],
    checkpointScopes: [
      {
        id: scopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp",
        createdAt: now,
      },
    ],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  } as unknown as OrchestrationV2ThreadProjection;
  const events: OrchestrationV2DomainEvent[] = [];
  const write = ({ events: incoming }: { events: readonly OrchestrationV2DomainEvent[] }) =>
    Effect.sync(() => {
      events.push(...incoming);
      for (const event of incoming)
        projection = ProjectionStore.applyToProjection(projection, event);
      return { committed: true, storedEvents: [] } as never;
    });
  const ensureThread = vi.fn(() => Effect.succeed(providerThread));
  const startTurn = vi.fn(() => Effect.void);
  const authCommand = vi.fn(() => Effect.succeed(true));
  const open = vi.fn(() =>
    Effect.sync(() => {
      if (options.revokeAt === "open") grantActive = false;
      return {
        driver,
        ensureThread,
        startTurn,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/tmp",
          model: null,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      } as never;
    }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent: write, write }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getTurnStartContext: () => Effect.succeed({ ...projection, hasConversation: true }),
          getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          getThreadShell: () =>
            Effect.succeed({
              ...projection.thread,
              activeRunId: runId,
              status: projection.runs[0]!.status,
              pendingRuntimeRequest: null,
              hasActionableProposedPlan: false,
              pendingBackgroundTasks: [],
            } as never),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            experimental: { externalMcp: { enabled: options.deny !== "settings" } },
          } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ open }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: authCommand,
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun: (input) =>
            Effect.gen(function* () {
              if (options.revokeAt === "send") grantActive = false;
              yield* input.session.startTurn({ message: input.message } as never).pipe(
                Effect.mapError(
                  (cause) =>
                    new RunExecutionService.RunExecutionStartError({
                      commandId: input.commandId,
                      runId: input.run.id,
                      cause,
                    }),
                ),
              );
            }),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        FileSystem.layerNoop({}),
        IdAllocator.layer,
      ),
    ),
  );
  return {
    open,
    ensureThread,
    startTurn,
    authCommand,
    events,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

it.effect.each(["grant", "member", "settings"] as const)(
  "terminalizes a queued turn after %s denial",
  (deny) =>
    Effect.gen(function* () {
      const f = fixture({ deny });
      yield* f.start;
      expect(f.open).not.toHaveBeenCalled();
      expect(f.projection().runs[0]?.status).toBe("failed");
      expect(f.events.find((event) => event.type === "turn-item.updated")?.payload).toMatchObject({
        type: "error",
        title: "Background turn was not sent",
      });
    }),
);

it.effect("checks again after provider open and before native thread creation", () =>
  Effect.gen(function* () {
    const f = fixture({ revokeAt: "open" });
    yield* f.start;
    expect(f.open).toHaveBeenCalledOnce();
    expect(f.ensureThread).not.toHaveBeenCalled();
    expect(f.startTurn).not.toHaveBeenCalled();
    expect(f.projection().runs[0]?.status).toBe("failed");
  }),
);

it.effect("checks the original grant immediately before the final provider send", () =>
  Effect.gen(function* () {
    const f = fixture({ revokeAt: "send" });
    const exit = yield* Effect.exit(f.start);
    expect(exit._tag).toBe("Failure");
    expect(f.ensureThread).toHaveBeenCalledOnce();
    expect(f.startTurn).not.toHaveBeenCalled();
  }),
);

it.effect("blocks native slash commands before account control side effects", () =>
  Effect.gen(function* () {
    const f = fixture({ text: "  /logout" });
    yield* f.start;
    expect(f.authCommand).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
    expect(f.projection().runs[0]?.status).toBe("failed");
  }),
);

it.effect("preserves interactive native commands without an external grant", () =>
  Effect.gen(function* () {
    const f = fixture({ text: "/logout", background: false, deny: "settings" });
    yield* f.start;
    expect(f.authCommand).toHaveBeenCalledOnce();
    expect(f.projection().runs[0]?.status).toBe("completed");
  }),
);

it.effect("starts an authorized member turn without substituting its different owner", () =>
  Effect.gen(function* () {
    const f = fixture();
    yield* f.start;
    expect(f.startTurn).toHaveBeenCalledOnce();
    expect(vi.mocked(isActiveExternalGrant)).toHaveBeenCalledWith(
      UserId.make("original-actor"),
      "original-grant",
    );
  }),
);
