// T3-CUSTOM(expbkt3): a released provider session settles the subagents it leaves open.
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2Shape,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const parentThreadId = ThreadId.make("released-parent-thread");
const childThreadId = (name: string) => ThreadId.make(`released-child-${name}`);
const releasedSessionId = ProviderSessionId.make("released-session");
const otherSessionId = ProviderSessionId.make("other-session");
const otherProviderThreadId = ProviderThreadId.make("other-session-provider-thread");
const epoch = DateTime.makeUnsafe("1970-01-01T00:00:00Z");
/** The release happens ten minutes in (TestClock), after `epoch`, before `later`. */
const later = DateTime.makeUnsafe("1970-01-01T00:20:00Z");

type Projection = ProjectionStore.ProjectionRuntimeRecoveryState;

function subagent(
  name: string,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`subagent-${name}`),
    threadId: parentThreadId,
    runId: null,
    parentNodeId: NodeId.make("parent-root"),
    origin: "provider_native",
    createdBy: "agent",
    driver,
    providerInstanceId: instanceId,
    providerThreadId: null,
    childThreadId: childThreadId(name),
    nativeTaskRef: null,
    prompt: `review ${name}`,
    title: null,
    model: null,
    status: "running",
    result: null,
    startedAt: epoch,
    completedAt: null,
    updatedAt: epoch,
    ...overrides,
  };
}

/** The parent's card for a subagent. */
function subagentItem(task: OrchestrationV2Subagent) {
  return {
    id: TurnItemId.make(`card-${task.id}`),
    threadId: task.threadId,
    runId: task.runId,
    nodeId: task.id,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: task.status,
    title: null,
    startedAt: task.startedAt,
    completedAt: null,
    updatedAt: task.updatedAt,
    type: "subagent" as const,
    subagentId: task.id,
    origin: task.origin,
    driver: task.driver,
    providerInstanceId: task.providerInstanceId,
    childThreadId: task.childThreadId,
    prompt: task.prompt,
    result: null,
  };
}

function node(
  id: string,
  threadId: ThreadId,
  kind: "subagent" | "root_turn",
  startedAt: DateTime.Utc = epoch,
) {
  return {
    id: NodeId.make(id),
    threadId,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make(id),
    kind,
    status: "running" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  };
}

function projection(threadId: ThreadId, records: Partial<Projection>): Projection {
  return {
    thread: { id: threadId },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    turnItems: [],
    ...records,
  } as unknown as Projection;
}

/**
 * The incident's shape: a parent whose turn completed while its background
 * subagent kept working in a child thread (a runless root turn with a running
 * command), next to subagents the release must leave alone.
 */
function incidentProjections(): ReadonlyMap<ThreadId, Projection> {
  const running = subagent("running");
  const startedLater = subagent("started-later", { startedAt: later, updatedAt: later });
  const otherSession = subagent("other-session", { providerThreadId: otherProviderThreadId });
  const delegated = subagent("delegated", { origin: "app_owned" });
  const otherDriver = subagent("other-driver", { driver: ProviderDriverKind.make("codex") });
  const finished = subagent("finished", { status: "completed", completedAt: epoch });
  // Its provider thread was not loaded: it may run in another shared session.
  const unloadedThread = subagent("unloaded-thread", {
    providerThreadId: ProviderThreadId.make("unloaded-provider-thread"),
  });
  const tasks = [
    running,
    startedLater,
    otherSession,
    delegated,
    otherDriver,
    finished,
    unloadedThread,
  ];
  const childRoot = node("child-root-running", childThreadId("running"), "root_turn");
  // The last thing the stopped subagent ran, still open under its root turn.
  const childCommand = {
    id: TurnItemId.make("child-command"),
    threadId: childThreadId("running"),
    runId: null,
    nodeId: childRoot.id,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 2,
    status: "running" as const,
    title: null,
    startedAt: epoch,
    completedAt: null,
    updatedAt: epoch,
    type: "command_execution" as const,
    input: "cat notes.md",
  };
  return new Map<ThreadId, Projection>([
    [
      parentThreadId,
      projection(parentThreadId, {
        subagents: tasks,
        turnItems: tasks.map(subagentItem) as never,
        nodes: tasks.map((task) => node(task.id, parentThreadId, "subagent")),
        providerThreads: [
          { id: otherProviderThreadId, providerSessionId: otherSessionId } as never,
        ],
      }),
    ],
    [
      childThreadId("running"),
      projection(childThreadId("running"), {
        nodes: [childRoot],
        turnItems: [childCommand] as never,
      }),
    ],
    // Reached only if the release wrongly settled their subagents.
    ...["started-later", "other-session", "delegated", "other-driver", "unloaded-thread"].map(
      (name) =>
        [
          childThreadId(name),
          projection(childThreadId(name), {
            nodes: [node(`child-root-${name}`, childThreadId(name), "root_turn")],
          }),
        ] as const,
    ),
  ]);
}

function fixture(
  options: {
    readonly projections?: ReadonlyMap<ThreadId, Projection>;
    readonly failRecoveryRead?: boolean;
  } = {},
) {
  const projections = options.projections ?? incidentProjections();
  const written: Array<OrchestrationV2DomainEvent> = [];
  /** Threads whose full recovery read ran, in order. */
  const recoveryReads: Array<ThreadId> = [];
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
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
            createdAt: epoch,
            updatedAt: epoch,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: unused,
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
  const layer = ProviderSessionManager.layerWithOptions({
    // The clock moves in these tests; idle release must not run on its own.
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    configureMcp: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        FileSystem.layerNoop({}),
        ProviderAdapterRegistry.layerSingle(adapter),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            Effect.sync(() => {
              written.push(...input.events);
              return [];
            }),
        }),
        Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (threadId) =>
            Effect.succeed({
              thread: { id: threadId },
              messages: [],
              runtimeRequests: [],
              nodes: [],
              turnItems: [],
              providerThreads: [],
              providerTurns: [],
              subagents: projections.get(threadId)?.subagents ?? [],
            } as unknown as OrchestrationV2ThreadProjection),
          getRuntimeRecoveryProjection: (threadId) => {
            recoveryReads.push(threadId);
            if (options.failRecoveryRead === true) {
              return Effect.fail(
                new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "boom" }),
              );
            }
            const found = projections.get(threadId);
            return found === undefined
              ? Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }))
              : Effect.succeed(found);
          },
        }),
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          revokeThread: () => Effect.void,
          revokeProviderSession: () => Effect.void,
        }),
      ),
    ),
  );
  const open = (threadId: ThreadId, providerSessionId = releasedSessionId) => ({
    threadId,
    providerSessionId,
    modelSelection: { instanceId, model: "test" },
    runtimePolicy: { cwd: null, runtimeMode: "full-access", interactionMode: "default" } as const,
  });
  /** The cancellations the release wrote, by event type. */
  const cancelled = (type: "subagent.updated" | "turn-item.updated" | "node.updated") =>
    written.flatMap((event) => {
      if (
        event.type !== type ||
        (event.type !== "subagent.updated" &&
          event.type !== "turn-item.updated" &&
          event.type !== "node.updated")
      ) {
        return [];
      }
      return event.payload.status === "cancelled" ? [String(event.payload.id)] : [];
    });
  return { layer, written, recoveryReads, open, cancelled };
}

it.effect(
  "a released session cancels the subagent it left running, its card and its child thread",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      yield* manager.open(f.open(parentThreadId));
      yield* TestClock.adjust("10 minutes");
      yield* manager.release({ providerSessionId: releasedSessionId, reason: "manual_shutdown" });

      assert.isTrue(Option.isNone(yield* manager.get(releasedSessionId)));
      assert.deepEqual(f.cancelled("subagent.updated"), ["subagent-running"]);
      assert.sameMembers(f.cancelled("turn-item.updated"), [
        "card-subagent-running",
        "child-command",
      ]);
      assert.sameMembers(f.cancelled("node.updated"), ["subagent-running", "child-root-running"]);
      // Started after the release, on another session, a delegate_task child,
      // another provider, already finished, on an unloaded provider thread:
      // none of them is touched.
      const touched = f.written.flatMap((event) =>
        event.type === "subagent.updated" ||
        event.type === "turn-item.updated" ||
        event.type === "node.updated"
          ? [String(event.payload.id)]
          : [],
      );
      for (const name of [
        "started-later",
        "other-session",
        "delegated",
        "other-driver",
        "finished",
        "unloaded-thread",
      ]) {
        assert.notInclude(touched, `subagent-${name}`);
        assert.notInclude(touched, `card-subagent-${name}`);
        assert.notInclude(touched, `child-root-${name}`);
      }
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a detach that leaves the shared session open settles nothing", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* manager.open(f.open(parentThreadId));
    yield* manager.open(f.open(ThreadId.make("released-sibling-thread")));
    yield* TestClock.adjust("10 minutes");
    yield* manager.detach({ providerSessionId: releasedSessionId, threadId: parentThreadId });

    assert.isTrue(Option.isSome(yield* manager.get(releasedSessionId)));
    assert.deepEqual(f.cancelled("subagent.updated"), []);
    assert.deepEqual(f.cancelled("turn-item.updated"), []);
    assert.deepEqual(f.cancelled("node.updated"), []);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a thread another live session still serves keeps its subagents", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* manager.open(f.open(parentThreadId));
    yield* manager.open(f.open(parentThreadId, otherSessionId));
    yield* TestClock.adjust("10 minutes");
    yield* manager.release({ providerSessionId: releasedSessionId, reason: "manual_shutdown" });

    assert.deepEqual(f.cancelled("subagent.updated"), []);
    assert.deepEqual(f.cancelled("node.updated"), []);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a server shutdown leaves the subagents to startup recovery and its wake", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* manager.open(f.open(parentThreadId));
    yield* TestClock.adjust("10 minutes");
    yield* manager.release({ providerSessionId: releasedSessionId, reason: "server_shutdown" });

    assert.deepEqual(f.cancelled("subagent.updated"), []);
    assert.deepEqual(f.cancelled("node.updated"), []);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a release with no open subagent skips the full recovery read", () => {
  const finished = subagent("finished", { status: "completed", completedAt: epoch });
  const f = fixture({
    projections: new Map([
      [
        parentThreadId,
        projection(parentThreadId, {
          subagents: [finished],
          turnItems: [subagentItem(finished)] as never,
        }),
      ],
    ]),
  });
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* manager.open(f.open(parentThreadId));
    yield* TestClock.adjust("10 minutes");
    yield* manager.release({ providerSessionId: releasedSessionId, reason: "idle_timeout" });

    assert.isTrue(Option.isNone(yield* manager.get(releasedSessionId)));
    assert.deepEqual(f.recoveryReads, []);
    assert.deepEqual(f.cancelled("subagent.updated"), []);
  }).pipe(Effect.provide(f.layer));
});

it.effect("a failed subagent read never fails the release", () => {
  const f = fixture({ failRecoveryRead: true });
  return Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    yield* manager.open(f.open(parentThreadId));
    yield* manager.release({ providerSessionId: releasedSessionId, reason: "runtime_error" });

    assert.isTrue(Option.isNone(yield* manager.get(releasedSessionId)));
    assert.isTrue(
      f.written.some(
        (event) => event.type === "provider-session.updated" && event.payload.status === "error",
      ),
    );
    assert.deepEqual(f.cancelled("subagent.updated"), []);
  }).pipe(Effect.provide(f.layer));
});
