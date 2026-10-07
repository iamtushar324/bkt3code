// T3-CUSTOM(expbkt3): exercise process and credential boundaries with a real session manager.
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  EnvironmentId,
  PersonalMcpIntegrationId,
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

function fixture(provider = "codex") {
  const now = DateTime.makeUnsafe("2026-10-03T00:00:00Z");
  const threadId = ThreadId.make("background-process-thread");
  const actor = UserId.make("original-member");
  const owner = UserId.make("other-owner");
  const messageId = MessageId.make("original-message");
  const runId = RunId.make("original-run");
  const instanceId = ProviderInstanceId.make(provider);
  const driver = ProviderDriverKind.make(provider);
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
    onInspect: Effect.void as Effect.Effect<void>,
    upstreamServers: [] as ReadonlyArray<McpProviderSession.McpUpstreamServerConfig>,
    inspectionUnavailable: false,
    pendingPrompt: false,
    pendingWork: false,
    events: undefined as Queue.Queue<ProviderAdapterV2Event, Cause.Done> | undefined,
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
        state.events = events;
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
          hasPendingBackgroundWork: Effect.sync(() => state.pendingWork),
        };
      }),
  };
  const layer = ProviderSessionManager.layerWithOptions({ idleTimeoutMs: 60_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        ProviderAdapterRegistry.layerSingle(adapter),
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
              pendingRuntimeRequest: state.pendingPrompt ? { id: "human-question" } : null,
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
                  upstreamServers: state.upstreamServers,
                  browserToolsAvailable: false,
                },
                expiresAt: Number.MAX_SAFE_INTEGER,
              };
            }),
          inspectUpstreamServers: () =>
            state.onInspect.pipe(
              Effect.map(() => (state.inspectionUnavailable ? undefined : state.upstreamServers)),
            ),
          resolve: (token) =>
            Effect.sync(() => {
              const index = Number(token.replace("credential-", "")) - 1;
              const request = issued[index];
              return request
                ? ({
                    threadId: request.threadId,
                    providerInstanceId: request.providerInstanceId,
                    actorUserId: request.actorUserId ?? null,
                    backgroundGrantHash: request.backgroundGrantHash,
                    capabilities: new Set(),
                  } as never)
                : undefined;
            }),
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

it.effect.each(["grant", "stop"] as const)(
  "does not open a process after %s changes during MCP preparation",
  (change) => {
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
  },
);

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

const toolyardServer = (
  allowedTools: string[] = [],
): McpProviderSession.McpUpstreamServerConfig => ({
  id: PersonalMcpIntegrationId.make("toolyard"),
  name: "toolyard",
  endpoint: "http://localhost/mcp/upstream/toolyard",
  authMode: "bearer",
  allowedTools,
});

it.effect.each(["codex", "claude-code", "cursor", "grok", "opencode", "antigravity"])(
  "%s receives a newly enabled Toolyard proxy on the next idle reuse",
  (provider) => {
    const f = fixture(provider);
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const original = yield* manager.open(f.open);
      f.state.upstreamServers = [toolyardServer()];
      const replacement = yield* manager.open(f.open);
      expect(replacement).not.toBe(original);
      expect(f.state.opened).toBe(2);
      expect(f.state.closed).toBe(1);
      expect(McpProviderSession.readMcpProviderSession(f.threadId)?.upstreamServers).toEqual(
        f.state.upstreamServers,
      );
      expect(yield* manager.open(f.open)).toBe(replacement);
      expect(f.state.opened).toBe(2);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["tools", "endpoint", "source"])(
  "restarts an idle provider after its upstream %s changes",
  (change) => {
    const f = fixture();
    f.state.upstreamServers = [toolyardServer(["inbox.status"])];
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const original = yield* manager.open(f.open);
      f.state.upstreamServers = [
        {
          ...toolyardServer(["inbox.status"]),
          ...(change === "tools" ? { allowedTools: ["inbox.status", "inbox.request"] } : {}),
          ...(change === "endpoint"
            ? { endpoint: "http://new-localhost/mcp/upstream/toolyard" }
            : {}),
          ...(change === "source" ? { configurationKey: "replacement-instance" } : {}),
        },
      ];
      expect(yield* manager.open(f.open)).not.toBe(original);
      expect(f.state.closed).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["prompt", "background"])(
  "retains the process and credential while a %s is pending",
  (pending) => {
    const f = fixture();
    const open = { ...f.open, messageId: f.messages[1]!.id };
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const original = yield* manager.open(open);
      const credential = McpProviderSession.readMcpProviderSession(f.threadId)?.authorizationHeader;
      f.state.upstreamServers = [toolyardServer()];
      f.state.pendingPrompt = pending === "prompt";
      f.state.pendingWork = pending === "background";
      expect(yield* manager.open(open)).toBe(original);
      expect(f.state.closed).toBe(0);
      expect(McpProviderSession.readMcpProviderSession(f.threadId)?.authorizationHeader).toBe(
        credential,
      );
      f.state.pendingPrompt = false;
      f.state.pendingWork = false;
      expect(yield* manager.open(open)).not.toBe(original);
      expect(f.state.closed).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each([false, true])(
  "retains an active turn through a configuration change (inspection race: %s)",
  (race) => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const original = yield* manager.open(f.open);
      const credential = McpProviderSession.readMcpProviderSession(f.threadId)?.authorizationHeader;
      f.state.upstreamServers = [toolyardServer()];
      const start = original.startTurn({
        threadId: f.threadId,
        modelSelection: { model: "test-model" },
      } as never);
      if (race) f.state.onInspect = start.pipe(Effect.orDie);
      else yield* start;
      expect(yield* manager.open(f.open)).toBe(original);
      expect(f.state.closed).toBe(0);
      expect(McpProviderSession.readMcpProviderSession(f.threadId)?.authorizationHeader).toBe(
        credential,
      );
      f.state.onInspect = Effect.void;
      yield* Queue.offer(f.state.events!, {
        type: "turn.terminal",
        driver: ProviderDriverKind.make("codex"),
        providerThreadId: "provider-thread",
        providerTurnId: "provider-turn",
        runOrdinal: 1,
        status: "completed",
        failure: null,
        threadDisposition: "reusable",
      } as never);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      expect(yield* manager.open(f.open)).not.toBe(original);
      expect(f.state.closed).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "retains an idle healthy provider and its credentials when the profile snapshot is unavailable",
  () => {
    const f = fixture();
    f.state.upstreamServers = [toolyardServer()];
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const original = yield* manager.open(f.open);
      const credential = McpProviderSession.readMcpProviderSession(f.threadId)?.authorizationHeader;
      f.state.upstreamServers = [];
      f.state.inspectionUnavailable = true;
      expect(yield* manager.open(f.open)).toBe(original);
      expect(f.state.closed).toBe(0);
      expect(f.issued).toHaveLength(1);
      expect(McpProviderSession.readMcpProviderSession(f.threadId)?.authorizationHeader).toBe(
        credential,
      );
      f.state.inspectionUnavailable = false;
      expect(yield* manager.open(f.open)).not.toBe(original);
      expect(f.state.closed).toBe(1);
      expect(f.issued).toHaveLength(2);
    }).pipe(Effect.provide(f.layer));
  },
);

const humanMessage = (id: string, sender: UserId) => ({
  id: MessageId.make(id),
  role: "user",
  sentByUserId: sender,
  createdBy: "user",
  creationSource: "web",
  runId: null,
});

// A wake continuation, restart continuation, or task notification: no sender of its own.
const continuationMessage = (id: string) => ({
  id: MessageId.make(id),
  role: "user",
  sentByUserId: null,
  createdBy: "agent",
  creationSource: "provider",
  runId: null,
});

const replaceMessages = (
  f: ReturnType<typeof fixture>,
  messages: ReadonlyArray<Record<string, unknown>>,
) => {
  f.messages.splice(0, f.messages.length, ...(messages as never[]));
};

it.effect(
  "an agent-created continuation keeps the last sender's process and its background work",
  () => {
    const f = fixture("claudeAgent");
    replaceMessages(f, [humanMessage("human-turn", f.actor), continuationMessage("wake-turn")]);
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const original = yield* manager.open({ ...f.open, messageId: MessageId.make("human-turn") });
      // The completed turn left a subagent and a Monitor running in the process.
      f.state.pendingWork = true;
      const continuation = yield* manager.open({
        ...f.open,
        messageId: MessageId.make("wake-turn"),
      });
      expect(continuation).toBe(original);
      expect(continuation.credentialActorUserId).toBe(f.actor);
      expect(f.state.opened).toBe(1);
      expect(f.state.closed).toBe(0);
      expect(f.issued).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a usage-limit resume keeps the last sender's process and its background work", () => {
  const f = fixture("claudeAgent");
  // UsageLimitRecoveryWorker writes its resume as createdBy "user" from the server, with no sender.
  replaceMessages(f, [
    humanMessage("human-turn", f.actor),
    { ...continuationMessage("limit-resume"), createdBy: "user", creationSource: "server" },
  ]);
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const original = yield* manager.open({ ...f.open, messageId: MessageId.make("human-turn") });
    f.state.pendingWork = true;
    const resumed = yield* manager.open({ ...f.open, messageId: MessageId.make("limit-resume") });
    expect(resumed).toBe(original);
    expect(f.state.closed).toBe(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a human turn from a different person still restarts the process", () => {
  const f = fixture("claudeAgent");
  replaceMessages(f, [
    humanMessage("first-person-turn", f.actor),
    humanMessage("second-person-turn", f.owner),
  ]);
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const original = yield* manager.open({
      ...f.open,
      messageId: MessageId.make("first-person-turn"),
    });
    const replacement = yield* manager.open({
      ...f.open,
      messageId: MessageId.make("second-person-turn"),
    });
    expect(replacement).not.toBe(original);
    expect(replacement.credentialActorUserId).toBe(f.owner);
    expect(f.state.opened).toBe(2);
    expect(f.state.closed).toBe(1);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a continuation in a thread with no human message keeps today's owner identity", () => {
  const f = fixture("claudeAgent");
  replaceMessages(f, [continuationMessage("only-continuation")]);
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const open = { ...f.open, messageId: MessageId.make("only-continuation") };
    const original = yield* manager.open(open);
    // Unchanged: no sender to inherit, so the actor falls back to the thread owner.
    expect(original.credentialActorUserId).toBe(f.owner);
    expect(f.issued[0]?.actorUserId).toBe(f.owner);
    expect(yield* manager.open(open)).toBe(original);
    expect(f.state.closed).toBe(0);
  }).pipe(Effect.provide(f.layer));
});
