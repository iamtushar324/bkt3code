// T3-CUSTOM(expbkt3): exercise process and credential boundaries with a real session manager.
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  ThreadId,
  UserId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { SessionIdentityEnvironmentService } from "../identity/SessionIdentityEnvironment.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { isActiveExternalGrant } from "../mcp/UserMcpProfileStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

vi.mock("../mcp/UserMcpProfileStore.ts", () => ({ isActiveExternalGrant: vi.fn() }));

function fixture() {
  const now = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
  const threadId = ThreadId.make("background-process-thread");
  const actor = UserId.make("original-member");
  const owner = UserId.make("other-owner");
  const messageId = MessageId.make("original-message");
  const runId = RunId.make("original-run");
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const providerSessionId = ProviderSessionId.make("background-process");
  const modelSelection = { instanceId, model: "test" };
  const runtimePolicy = {
    cwd: null,
    runtimeMode: "full-access",
    interactionMode: "default",
  } as const;
  const state = {
    grantActive: true,
    stopped: false,
    opened: 0,
    closed: 0,
    ensured: 0,
    onIssue: () => {},
  };
  const issued: McpSessionRegistry.McpCredentialRequest[] = [];
  const thread = {
    id: threadId,
    ownerUserId: owner,
    memberUserIds: [actor],
    archivedAt: null,
    deletedAt: null,
  };
  const messages = [
    {
      id: messageId,
      role: "user",
      sentByUserId: actor,
      backgroundGrantHash: "original-grant",
      runId,
    },
    { id: MessageId.make("later-human-message"), role: "user", sentByUserId: owner, runId: null },
  ];
  vi.mocked(isActiveExternalGrant).mockImplementation((user, hash) =>
    Effect.succeed(state.grantActive && user === actor && hash === "original-grant"),
  );
  McpProviderSession.clearMcpProviderSession(threadId);
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        state.opened++;
        const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.closed++;
          }),
        );
        const unused = () =>
          Effect.fail(new ProviderAdapterProtocolError({ driver, detail: "unused" }));
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready" as const,
            cwd: "/tmp",
            model: "test",
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: () =>
            Effect.sync(() => {
              state.ensured++;
              return { id: "provider-thread", nativeThreadRef: null } as never;
            }),
          resumeThread: (request) => Effect.succeed(request.providerThread),
          forkThread: unused,
          readThreadSnapshot: unused,
          rollbackThread: unused,
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
        };
      }),
  };
  const layer = ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        ProviderAdapterRegistry.makeSingleLayer(adapter),
        Layer.mock(EventSink.EventSinkV2)({ write: () => Effect.succeed([]) }),
        Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: () => Effect.succeed(thread as never),
          getThreadRecords: () =>
            Effect.succeed({
              thread,
              messages,
              runtimeRequests: [],
              nodes: [],
              turnItems: [],
            } as unknown as OrchestrationV2ThreadProjection),
          getThreadShell: () =>
            Effect.succeed({
              ...thread,
              activeRunId: state.stopped ? null : runId,
              status: state.stopped ? "interrupted" : "starting",
              pendingRuntimeRequest: null,
              hasActionableProposedPlan: false,
              pendingBackgroundTasks: [],
            } as never),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            experimental: { externalMcp: { enabled: true } },
            projectSettingsOverrides: {},
            enableAgentBrowserAccess: false,
            enableAgentDeviceAccess: false,
          } as never),
        }),
        Layer.mock(SessionIdentityEnvironmentService)({
          resolve: ({ senderUserId }) =>
            Effect.succeed({ BK_MESSAGE_SENDER_EMAIL: String(senderUserId) }),
        }),
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          issue: (request) =>
            Effect.sync(() => {
              issued.push(request);
              state.onIssue();
              return {
                config: {
                  environmentId: EnvironmentId.make("environment"),
                  threadId: request.threadId,
                  providerInstanceId: request.providerInstanceId,
                  providerSessionId: `credential-${issued.length}`,
                  actorUserId: request.actorUserId ?? null,
                  endpoint: "http://localhost/mcp",
                  authorizationHeader: `Bearer credential-${issued.length}`,
                  upstreamServers: [],
                  browserToolsAvailable: false,
                },
                expiresAt: Number.MAX_SAFE_INTEGER,
              };
            }),
          resolve: () => Effect.undefined,
          revokeThread: () => Effect.void,
          revokeProviderSession: () => Effect.void,
        }),
      ),
    ),
  );
  return {
    state,
    issued,
    messages,
    layer,
    actor,
    owner,
    threadId,
    messageId,
    open: { threadId, messageId, providerSessionId, modelSelection, runtimePolicy },
  };
}

for (const change of ["grant", "stop"] as const) {
  it.effect(`does not open a process after ${change} changes during MCP preparation`, () => {
    const f = fixture();
    f.state.onIssue = () => {
      if (change === "grant") f.state.grantActive = false;
      else f.state.stopped = true;
    };
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const result = yield* Effect.result(manager.open(f.open));
      expect(result._tag).toBe("Failure");
      expect(f.issued).toHaveLength(1);
      expect(f.state.opened).toBe(0);
      expect(McpProviderSession.readMcpProviderSession(f.threadId)).toBeUndefined();
    }).pipe(Effect.provide(f.layer));
  });
}

it.effect(
  "reuses only the original member's granted process and refuses reuse after revocation",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const first = yield* manager.open(f.open);
      const second = yield* manager.open(f.open);
      expect(second).toBe(first);
      expect(first.credentialActorUserId).toBe(f.actor);
      expect(f.issued[0]?.actorUserId).toBe(f.actor);
      expect(f.issued[0]?.backgroundGrantHash).toBe("original-grant");
      expect(f.state.opened).toBe(1);
      f.state.grantActive = false;
      expect((yield* Effect.result(manager.open(f.open)))._tag).toBe("Failure");
      expect(f.state.opened).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "human rollback without a message does not inherit the completed background grant",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* manager.open(f.open);
      f.state.grantActive = false;
      f.state.stopped = true;
      f.messages.splice(1);
      const { messageId: _, ...rollback } = f.open;
      const runtime = yield* manager.open(rollback);
      expect(runtime.credentialActorUserId).toBe(f.actor);
      expect(f.state.opened).toBe(2);
      expect(f.state.closed).toBe(1);
      expect(f.issued.at(-1)?.backgroundGrantHash).toBeUndefined();
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a background process keeps its actor and grant when it attaches another thread", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runtime = yield* manager.open(f.open);
    const otherThread = ThreadId.make("background-second-thread");
    yield* runtime.ensureThread({
      threadId: otherThread,
      modelSelection: f.open.modelSelection,
      runtimePolicy: f.open.runtimePolicy,
    } as never);
    expect(f.state.ensured).toBe(1);
    expect(f.issued.at(-1)?.threadId).toBe(otherThread);
    expect(f.issued.at(-1)?.actorUserId).toBe(f.actor);
    expect(f.issued.at(-1)?.backgroundGrantHash).toBe("original-grant");
  }).pipe(Effect.provide(f.layer));
});
