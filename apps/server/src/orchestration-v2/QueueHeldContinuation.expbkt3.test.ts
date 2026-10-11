// T3-CUSTOM(expbkt3): an adapter continuation starts past a held queue; user messages keep waiting.
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapterV2Shape;
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: a started run stays "starting" until the test ends it, and the
// provider-turn.start effect that would run it stays in the outbox.
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProviderReplayHarness.layerWithRegistry(
    { name: "queue-held-continuation" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const messageIdFor = (threadId: ThreadId, label: string) =>
  MessageId.make(`message:${threadId}:${label}`);

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:queue-held-continuation"),
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const sendUserMessage = (
  threadId: ThreadId,
  label: string,
  type: "start_immediately" | "queue_after_active",
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${label}`),
      threadId,
      messageId: messageIdFor(threadId, label),
      text: label,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

/** The dispatch ProviderContinuationService sends when the CLI starts a turn by itself. */
const sendAdapterContinuation = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`provider-continuation:${threadId}:${label}`),
      threadId,
      messageId: messageIdFor(threadId, label),
      text: label,
      notification: {
        source: { kind: "background_task" },
        outcome: "updated",
        summary: "Background activity updated",
      },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "provider",
    });
  });

const runFor = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const messageId = messageIdFor(threadId, label);
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (candidate) => candidate.userMessageId === messageId,
    );
    assert.isDefined(run, `no run for ${label}`);
    return run!;
  });

const runStates = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return projection.runs
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`);
  });

/** Stop: interrupts the active run and holds every queued run for the user. */
const stop = (threadId: ThreadId, runId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make(`stop:${threadId}`),
      threadId,
      runId,
      holdQueue: true,
    });
  });

/** Ends a run the way its provider does: a terminal run.updated through the event sink. */
const completeRun = (run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${run.id}:completed`),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
  });

/** The first run the queue moved to "starting" after `afterSequence`, from persisted events. */
const firstStartedRunId = (threadId: ThreadId, afterSequence: number) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const started = yield* eventSink.stream({ threadId, afterSequence }).pipe(
      Stream.map((stored) =>
        stored.event.type === "run.updated" && stored.event.payload.status === "starting"
          ? stored.event.payload.id
          : null,
      ),
      Stream.filter((runId) => runId !== null),
      Stream.runHead,
    );
    return Option.getOrNull(started);
  });

const queuedStartEffects = (runId: RunId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox
      WHERE command_id = ${`command:system:start-queued:${runId}`}
    `;
    return rows.map((row) => row.effect_type);
  });

/**
 * A stopped thread: the user's queued message is held, and a later user turn runs
 * ahead of it, as on the thread where the Claude output was lost.
 */
const stoppedThreadWithActiveRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    yield* createThread(threadId);
    yield* sendUserMessage(threadId, "first", "start_immediately");
    yield* sendUserMessage(threadId, "queued before stop", "queue_after_active");
    yield* stop(threadId, (yield* runFor(threadId, "first")).id);
    yield* sendUserMessage(threadId, "after stop", "start_immediately");
    assert.deepEqual(yield* runStates(threadId), ["interrupted", "queued:held", "starting"]);
    return yield* runFor(threadId, "after stop");
  });

it.effect("an adapter continuation starts past a held queue while held messages wait", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:held-queue-continuation");
    const active = yield* stoppedThreadWithActiveRun(threadId);

    // The CLI starts a turn by itself while the active run is still finishing.
    yield* sendAdapterContinuation(threadId, "continuation");
    const continuation = yield* runFor(threadId, "continuation");
    assert.equal(continuation.status, "queued");
    assert.notEqual(continuation.queueHeld, true);
    assert.deepEqual(yield* runStates(threadId), [
      "interrupted",
      "queued:held",
      "starting",
      "queued",
    ]);

    const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
    yield* completeRun(active);
    assert.equal(yield* firstStartedRunId(threadId, afterSequence), continuation.id);
    assert.deepEqual(yield* runStates(threadId), [
      "interrupted",
      "queued:held",
      "completed",
      "starting",
    ]);
    assert.include(yield* queuedStartEffects(continuation.id), "provider-turn.start");
    const held = yield* runFor(threadId, "queued before stop");
    assert.deepEqual(yield* queuedStartEffects(held.id), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a user message queued behind a held queue is still held and does not start", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:held-queue-user-message");
    const active = yield* stoppedThreadWithActiveRun(threadId);

    yield* sendUserMessage(threadId, "queued after stop", "queue_after_active");
    const queued = yield* runFor(threadId, "queued after stop");
    assert.equal(queued.status, "queued");
    assert.isTrue(queued.queueHeld);

    yield* completeRun(active);
    // Runs the same queue decision as the terminal-run listener, synchronously.
    assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
    assert.deepEqual(yield* runStates(threadId), [
      "interrupted",
      "queued:held",
      "completed",
      "queued:held",
    ]);
    assert.deepEqual(yield* queuedStartEffects(queued.id), []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a thread whose only queued runs are held starts nothing until the user resumes", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:held-queue-only");
    const active = yield* stoppedThreadWithActiveRun(threadId);

    yield* completeRun(active);
    assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
    assert.deepEqual(yield* runStates(threadId), ["interrupted", "queued:held", "completed"]);

    yield* orchestrator.dispatch({
      type: "queue.resume",
      commandId: CommandId.make(`resume:${threadId}`),
      threadId,
    });
    assert.deepEqual(yield* runStates(threadId), ["interrupted", "starting", "completed"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["sqlite", "memory"] as const)(
  "canStartQueuedRun ignores held runs but not an unheld run behind them in %s",
  (storage) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:held-queue-store:${storage}`);
      const thread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project:held-queue-store"),
        title: "Held queue",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const queuedRun = (ordinal: number): OrchestrationV2Run => ({
        id: RunId.make(`run:held-queue-store:${ordinal}`),
        threadId,
        ordinal,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make(`message:held-queue-store:${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      });
      const putRun = (run: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`event:${run.id}:${run.status}:${String(run.queueHeld)}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: run,
        });
      yield* store.apply({
        id: EventId.make(`event:thread:${threadId}`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });

      const held = { ...queuedRun(1), queueHeld: true };
      yield* putRun(held);
      assert.isFalse(yield* store.canStartQueuedRun(threadId));

      const continuation = queuedRun(2);
      yield* putRun(continuation);
      assert.isTrue(yield* store.canStartQueuedRun(threadId));

      // An active run still blocks the queue.
      const active = { ...queuedRun(3), status: "running" as const, startedAt: now };
      yield* putRun(active);
      assert.isFalse(yield* store.canStartQueuedRun(threadId));
      yield* putRun({ ...active, status: "completed", completedAt: now });
      assert.isTrue(yield* store.canStartQueuedRun(threadId));

      // queue.resume writes queueHeld: false, which is not held.
      yield* putRun({ ...continuation, queueHeld: true });
      assert.isFalse(yield* store.canStartQueuedRun(threadId));
      yield* putRun({ ...held, queueHeld: false });
      assert.isTrue(yield* store.canStartQueuedRun(threadId));
    }).pipe(
      Effect.provide(
        storage === "sqlite"
          ? Layer.mergeAll(
              SqlitePersistence.layerMemory,
              ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            )
          : Layer.merge(SqlitePersistence.layerMemory, ProjectionStore.layerMemory),
      ),
    ),
);
