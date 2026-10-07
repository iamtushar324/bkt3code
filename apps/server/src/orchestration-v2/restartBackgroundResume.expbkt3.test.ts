// T3-CUSTOM(expbkt3): a restart wakes a settled run whose background work it cancelled.
import { assert, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
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
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { RESTART_WAKE_ENV } from "./restartBackgroundResume.expbkt3.ts";

const threadId = ThreadId.make("thread:wake");
const runId = RunId.make("run:wake");
const laterRunId = RunId.make("run:wake-later");
const instanceId = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const providerThreadId = ProviderThreadId.make("provider-thread:wake");
const sessionId = ProviderSessionId.make("session:wake");
const attemptId = RunAttemptId.make("attempt:wake");
const projectId = ProjectId.make("project:wake");
const monitorTask = { taskId: "monitor:ci", kind: "monitor", description: "Watch CI for PR 281" };
const monitorWork = {
  kind: "monitor" as const,
  label: "Watch CI for PR 281 (id monitor:ci)",
  id: "monitor:ci",
};

beforeEach(() => {
  vi.stubEnv(RESTART_WAKE_ENV, "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A Claude thread whose turn completed while a Monitor it armed was still pending. */
function settledProjection() {
  return {
    thread: {
      id: threadId,
      projectId,
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: { relationshipToParent: null, parentThreadId: null },
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        userMessageId: MessageId.make("message:original"),
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "claude-opus" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "completed",
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "idle",
        pendingBackgroundTasks: [monitorTask],
      },
    ],
    // Claude sessions stay "ready" between turns while the process lives.
    providerSessions: [{ id: sessionId, driver, providerInstanceId: instanceId, status: "ready" }],
    providerTurns: [],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

type Commit = Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0];
type Write = Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0];

const makeRecovery = (
  projection: OrchestrationV2ThreadProjection,
  continueThreadsAfterServerUpdate = true,
) =>
  Effect.gen(function* () {
    const commits: Array<Commit> = [];
    const writes: Array<Write> = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
            commitCommand: (input) =>
              Effect.sync(() => {
                commits.push(input);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            listByCommandId: () => Effect.succeed([]),
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    return { recovery, commits, writes };
  });

const startupEffects = (projection: OrchestrationV2ThreadProjection, enabled = true) =>
  Effect.gen(function* () {
    const { recovery, commits } = yield* makeRecovery(projection, enabled);
    yield* recovery.reconcile("startup");
    return commits.flatMap((commit) => commit.effects);
  });

it.effect("wakes a settled run whose pending Monitor a startup restart cancelled", () =>
  Effect.gen(function* () {
    const { recovery, commits } = yield* makeRecovery(settledProjection());
    yield* recovery.reconcile("startup");
    assert.lengthOf(commits, 1);
    const note = commits[0]!.events.find((event) => event.type === "run.background-work-cancelled");
    assert.equal(note?.runId, runId);
    assert.deepEqual(note?.payload.restartCancelledBackgroundWork, [monitorWork]);
    assert.deepEqual(
      commits[0]!.effects.map(({ id, request }) => ({ id, request })),
      [
        {
          id: `effect:restart-continuation:${runId}`,
          request: { type: "provider-runtime.continue", sourceRunId: runId, wakeSettledRun: true },
        },
      ],
    );
  }),
);

it.effect("leaves every thread asleep when the setting or the fork switch is off", () =>
  Effect.gen(function* () {
    assert.lengthOf(yield* startupEffects(settledProjection(), false), 0);
    vi.stubEnv(RESTART_WAKE_ENV, "0");
    assert.lengthOf(yield* startupEffects(settledProjection()), 0);
  }),
);

it.effect("keeps upstream's unmarked continuation for a turn cut mid-way", () =>
  Effect.gen(function* () {
    const base = settledProjection();
    const projection = {
      ...base,
      runs: [{ ...base.runs[0]!, status: "running" }],
      providerThreads: [{ ...base.providerThreads[0]!, status: "active" }],
      providerTurns: [
        {
          id: "provider-turn:wake",
          providerThreadId,
          runAttemptId: attemptId,
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const effects = yield* startupEffects(projection);
    assert.deepEqual(
      effects.map((effect) => effect.request),
      [{ type: "provider-runtime.continue", sourceRunId: runId }],
    );
  }),
);

it.effect("does not wake for app-owned delegations, stale sessions or held queues", () =>
  Effect.gen(function* () {
    const base = settledProjection();
    const delegationOnly = {
      ...base,
      providerThreads: [{ ...base.providerThreads[0]!, pendingBackgroundTasks: [] }],
      turnItems: [
        {
          id: TurnItemId.make("turn-item:delegation"),
          runId,
          nodeId: null,
          providerThreadId,
          type: "subagent",
          subagentId: NodeId.make("subagent:delegation"),
          origin: "app_owned",
          childThreadId: ThreadId.make("thread:child"),
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    // A stopped session's open records are leftovers, not live background work.
    const stoppedSession = {
      ...base,
      providerSessions: [{ ...base.providerSessions[0]!, status: "stopped" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const heldQueue = {
      ...base,
      runs: [...base.runs, { ...base.runs[0]!, id: laterRunId, ordinal: 2, status: "queued" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const delegatedChild = {
      ...base,
      thread: {
        ...base.thread,
        lineage: { relationshipToParent: "subagent", parentThreadId: ThreadId.make("parent") },
      },
    } as unknown as OrchestrationV2ThreadProjection;
    const archived = {
      ...base,
      thread: { ...base.thread, archivedAt: DateTime.makeUnsafe("2026-10-07T10:15:00Z") },
    } as unknown as OrchestrationV2ThreadProjection;
    for (const projection of [delegationOnly, stoppedSession, heldQueue, delegatedChild, archived])
      assert.lengthOf(yield* startupEffects(projection), 0);
  }),
);

it.effect("captures the wake before shutdown reconciliation cancels an open Monitor", () =>
  Effect.gen(function* () {
    const base = settledProjection();
    const projection = {
      ...base,
      providerThreads: [{ ...base.providerThreads[0]!, pendingBackgroundTasks: [] }],
      turnItems: [
        {
          id: TurnItemId.make("turn-item:monitor"),
          runId,
          nodeId: null,
          providerThreadId,
          type: "dynamic_tool",
          toolName: "Monitor",
          title: "Watch CI for PR 281",
          input: { persistent: true },
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const { recovery, writes } = yield* makeRecovery(projection);
    yield* recovery.prepareForShutdown;
    assert.deepEqual(
      writes.flatMap((write) => write.effects.map(({ id, request }) => ({ id, request }))),
      [
        {
          id: `effect:restart-continuation:${runId}`,
          request: { type: "provider-runtime.continue", sourceRunId: runId, wakeSettledRun: true },
        },
      ],
    );
  }),
);

/** The source run after reconciliation recorded the Monitor it cancelled. */
function reconciledProjection() {
  const base = settledProjection();
  return {
    ...base,
    runs: [{ ...base.runs[0]!, restartCancelledBackgroundWork: [monitorWork] }],
    providerTurns: [
      { id: "provider-turn:wake", providerThreadId, runAttemptId: attemptId, status: "completed" },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
}

const deliver = (projection: OrchestrationV2ThreadProjection, wake = true) =>
  Effect.gen(function* () {
    const commands: Array<
      Parameters<ThreadManagementService.ThreadManagementService["Service"]["dispatch"]>[0]
    > = [];
    yield* continueRestartedRun({
      threadId,
      sourceRunId: runId,
      wakeSettledRun: wake ? true : undefined,
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    return commands;
  });

it.effect("prompts the woken run with the restart note and a request to re-arm", () =>
  Effect.gen(function* () {
    const commands = yield* deliver(reconciledProjection());
    assert.lengthOf(commands, 1);
    const command = commands[0]!;
    assert.equal(command.type, "message.dispatch");
    if (command.type !== "message.dispatch") return;
    assert.equal(command.commandId, `command:restart-background-wake:${runId}`);
    assert.equal(command.messageId, `message:restart-continuation:${runId}`);
    assert.equal(command.restartContinuationOfRunId, runId);
    assert.include(command.text, "the T3 server restarted");
    assert.include(command.text, "- monitor: Watch CI for PR 281 (id monitor:ci)");
    assert.include(command.text, "re-arm monitors");
  }),
);

it.effect("delivers one wake, never after newer user work, and only when marked", () =>
  Effect.gen(function* () {
    const reconciled = reconciledProjection();
    const alreadyDelivered = {
      ...reconciled,
      messages: [{ id: MessageId.make(`message:restart-continuation:${runId}`) }],
    } as unknown as OrchestrationV2ThreadProjection;
    const userContinued = {
      ...reconciled,
      runs: [
        ...reconciled.runs,
        { ...reconciled.runs[0]!, id: laterRunId, ordinal: 2, status: "running" },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const nothingLost = {
      ...reconciled,
      runs: [{ ...reconciled.runs[0]!, restartCancelledBackgroundWork: [] }],
    } as unknown as OrchestrationV2ThreadProjection;
    for (const projection of [alreadyDelivered, userContinued, nothingLost])
      assert.lengthOf(yield* deliver(projection), 0);
    // An unmarked effect for a settled run stays inert, as upstream requires.
    assert.lengthOf(yield* deliver(reconciled, false), 0);
  }),
);
