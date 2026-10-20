// A background subagent that ends while no T3 turn runs completes its card at
// once, through the turn that settled last, instead of waiting for a
// continuation run to drain its notification. The harness follows the wake
// harness in ClaudeAdapterV2.test.ts.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";

const NATIVE_SESSION = "native-thread-claude-subagent-end";
const CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({});
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "ultrathink" }],
} satisfies ModelSelection;
const RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Claude subagent end test",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly providerTurnOrdinal: number;
  // A continuation run attaches to the wake output Claude already produced.
  readonly continuation?: boolean;
}): ProviderAdapterV2TurnInput {
  const continuation = input.continuation === true;
  return {
    appThread: makeAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: input.providerTurnOrdinal,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: continuation ? "agent" : "user",
      creationSource: continuation ? "provider" : "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: continuation ? "Background task completed." : "Run the reviews in the background.",
      attachments: [],
    },
    modelSelection: MODEL_SELECTION,
    runtimePolicy: RUNTIME_POLICY,
  };
}

function claudeSdkFrame(frame: unknown): SDKMessage {
  if (
    typeof frame !== "object" ||
    frame === null ||
    typeof Reflect.get(frame, "type") !== "string"
  ) {
    throw new Error("Frame is not a Claude Agent SDK message.");
  }
  return frame as SDKMessage;
}

const subagentStartedFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly description: string;
  readonly uuid: string;
  readonly spawnDepth?: number;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_started",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    description: input.description,
    subagent_type: "general-purpose",
    is_backgrounded: true,
    spawn_depth: input.spawnDepth ?? 1,
    task_type: "local_agent",
    prompt: `${input.description}.`,
    uuid: input.uuid,
    session_id: NATIVE_SESSION,
  });

const subagentProgressFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly description: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_progress",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    description: input.description,
    usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
    uuid: input.uuid,
    session_id: NATIVE_SESSION,
  });

// Shaped like the production notification: no parent_tool_use_id.
const subagentEndedFrame = (input: {
  readonly taskId: string;
  readonly toolUseId: string;
  readonly summary: string;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "system",
    subtype: "task_notification",
    task_id: input.taskId,
    tool_use_id: input.toolUseId,
    status: "completed",
    output_file: `/tmp/${input.taskId}.output`,
    summary: input.summary,
    uuid: input.uuid,
    session_id: NATIVE_SESSION,
  });

const subagentToolUseFrame = (input: {
  readonly parentToolUseId: string;
  readonly toolUseId: string;
  readonly name: string;
  readonly toolInput: Record<string, unknown>;
  readonly uuid: string;
}) =>
  claudeSdkFrame({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      id: `msg_${input.uuid}`,
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: input.toolUseId, name: input.name, input: input.toolInput },
      ],
    },
    parent_tool_use_id: input.parentToolUseId,
    uuid: input.uuid,
    session_id: NATIVE_SESSION,
  });

const resultFrame = (input: { readonly uuid: string; readonly result: string }) =>
  claudeSdkFrame({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: input.result,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: input.uuid,
    session_id: NATIVE_SESSION,
    terminal_reason: "completed",
  });

const makeHarness = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
  const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
  const continuationRequests: Array<ProviderContinuationRequest> = [];
  const events: Array<ProviderAdapterV2Event> = [];
  const eventReceipts = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    settings: CLAUDE_SETTINGS,
    environment: {},
    attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-claude-v2-subagent-end-",
    }),
    fileSystem,
    path: yield* Path.Path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    continuationRequests: {
      offer: (request) =>
        Effect.sync(() => {
          continuationRequests.push(request);
        }),
    },
    queryRunner: {
      allocateSessionId: Effect.succeed(NATIVE_SESSION),
      open: () =>
        Effect.sync(() => ({
          messages: Stream.fromQueue(sdkMessages).pipe(
            Stream.flatMap((message) =>
              Stream.make(message).pipe(
                // The next pull happens after runForEach finishes handling this frame.
                Stream.concat(
                  Stream.fromEffect(
                    Effect.suspend(() => {
                      const processed = processedMessages.get(message);
                      return processed === undefined
                        ? Effect.void
                        : Deferred.succeed(processed, undefined);
                    }),
                  ).pipe(Stream.drain),
                ),
              ),
            ),
          ),
          offer: () => Effect.void,
          setModel: () => Effect.void,
          applyFlagSettings: () => Effect.void,
          setPermissionMode: () => Effect.void,
          stopTask: () => Effect.void,
          backgroundTasks: () => Effect.succeed(false),
          interrupt: Effect.void,
          close: Effect.void,
        })),
      forkSession: () => Effect.die("unused forkSession"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const threadId = ThreadId.make("thread-claude-subagent-end");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-subagent-end"),
    modelSelection: MODEL_SELECTION,
    runtimePolicy: RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: MODEL_SELECTION,
    runtimePolicy: RUNTIME_POLICY,
  });
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        yield* Queue.offer(eventReceipts, event);
      }),
    ),
    Effect.forkScoped,
  );
  const now = yield* DateTime.now;
  // Resolves once the adapter has handled the frame.
  const offerAndWait = Effect.fnUntraced(function* (message: SDKMessage) {
    const processed = yield* Deferred.make<void>();
    processedMessages.set(message, processed);
    yield* Queue.offer(sdkMessages, message);
    yield* Deferred.await(processed);
  });
  // Takes emitted events in order until one matches, so every event before
  // it is already in `events`.
  const awaitEvent = (
    predicate: (event: ProviderAdapterV2Event) => boolean,
  ): Effect.Effect<ProviderAdapterV2Event> =>
    Queue.take(eventReceipts).pipe(
      Effect.flatMap((event) => (predicate(event) ? Effect.succeed(event) : awaitEvent(predicate))),
    );
  const startTurn = (input: {
    readonly attemptId: RunAttemptId;
    readonly providerTurnOrdinal: number;
    readonly continuation?: boolean;
  }) => runtime.startTurn(makeTurnInput({ ...input, threadId, providerThread, now }));
  return {
    sdkMessages,
    offerAndWait,
    awaitEvent,
    startTurn,
    continuationRequests,
    events,
    terminalCount: () => events.filter((event) => event.type === "turn.terminal").length,
  };
});

const isTurnTerminal = (event: ProviderAdapterV2Event) => event.type === "turn.terminal";
const isProgressEvent = (description: string) => (event: ProviderAdapterV2Event) =>
  event.type === "subagent.updated" && event.subagent.progress === description;

const subagentUpdates = (events: ReadonlyArray<ProviderAdapterV2Event>, taskId: string) =>
  events.flatMap((event) =>
    event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId
      ? [event.subagent]
      : [],
  );
const subagentNodeStatuses = (events: ReadonlyArray<ProviderAdapterV2Event>, taskId: string) =>
  events.flatMap((event) =>
    event.type === "node.updated" &&
    event.node.kind === "subagent" &&
    event.node.nativeItemRef?.nativeId === taskId
      ? [event.node.status]
      : [],
  );
const subagentCardStatuses = (events: ReadonlyArray<ProviderAdapterV2Event>, taskId: string) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "subagent" &&
    event.turnItem.nativeItemRef?.nativeId === taskId
      ? [event.turnItem.status]
      : [],
  );
const toolCallStatuses = (events: ReadonlyArray<ProviderAdapterV2Event>, toolUseId: string) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === toolUseId
      ? [`${event.turnItem.type}:${event.turnItem.status}`]
      : [],
  );
const withoutRepeats = <A>(values: ReadonlyArray<A>) =>
  values.filter((value, index) => value !== values[index - 1]);
// Anything stored for a subagent's card, node, child thread or its calls.
const touchesSubagent = (
  event: ProviderAdapterV2Event,
  taskId: string,
  childThreadId: string | null | undefined,
) => {
  switch (event.type) {
    case "subagent.updated":
      return event.subagent.nativeTaskRef?.nativeId === taskId;
    case "node.updated":
      return event.node.nativeItemRef?.nativeId === taskId || event.node.threadId === childThreadId;
    case "turn_item.updated":
      return (
        event.turnItem.nativeItemRef?.nativeId === taskId ||
        event.turnItem.threadId === childThreadId
      );
    case "message.updated":
      return event.message.threadId === childThreadId;
    default:
      return false;
  }
};

describe("ClaudeAdapterV2 subagent ends between turns", () => {
  const LAUNCH_ATTEMPT = RunAttemptId.make("attempt-claude-subagent-end-1");
  const CONTINUATION_ATTEMPT = RunAttemptId.make("attempt-claude-subagent-end-2");

  it.effect("completes a nested subagent's card when it ends while the root is idle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const OUTER_TASK_ID = "task-subagent-end-wave";
        const OUTER_TOOL_USE_ID = "toolu-subagent-end-wave";
        const NESTED_TASK_ID = "task-subagent-end-nested";
        const NESTED_TOOL_USE_ID = "toolu-subagent-end-nested";
        const harness = yield* makeHarness;

        // A background subagent starts a background subagent of its own, then
        // the root turn settles.
        yield* harness.startTurn({ attemptId: LAUNCH_ATTEMPT, providerTurnOrdinal: 1 });
        for (const frame of [
          subagentStartedFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            description: "Wave H",
            uuid: "00000000-0000-4000-8000-000000000c01",
          }),
          subagentToolUseFrame({
            parentToolUseId: OUTER_TOOL_USE_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            name: "Agent",
            toolInput: {
              description: "Review swap undo diff",
              prompt: "Review swap undo diff.",
              run_in_background: true,
            },
            uuid: "00000000-0000-4000-8000-000000000c02",
          }),
          subagentStartedFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            description: "Review swap undo diff",
            spawnDepth: 2,
            uuid: "00000000-0000-4000-8000-000000000c03",
          }),
          resultFrame({
            uuid: "00000000-0000-4000-8000-000000000c04",
            result: "The waves run in the background.",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitEvent(isTurnTerminal);
        assert.equal(subagentUpdates(harness.events, NESTED_TASK_ID).at(-1)?.status, "running");

        // The nested subagent ends while no turn runs. Claude reports that end
        // to the subagent that started it, so nothing wakes the root.
        yield* harness.offerAndWait(
          subagentEndedFrame({
            taskId: NESTED_TASK_ID,
            toolUseId: NESTED_TOOL_USE_ID,
            summary: "NESTED_DONE",
            uuid: "00000000-0000-4000-8000-000000000c05",
          }),
        );
        // The outer subagent's next progress marks when the end is recorded.
        yield* harness.offerAndWait(
          subagentProgressFrame({
            taskId: OUTER_TASK_ID,
            toolUseId: OUTER_TOOL_USE_ID,
            description: "Waiting on the review",
            uuid: "00000000-0000-4000-8000-000000000c06",
          }),
        );
        yield* harness.awaitEvent(isProgressEvent("Waiting on the review"));

        const nested = subagentUpdates(harness.events, NESTED_TASK_ID).at(-1);
        const outer = subagentUpdates(harness.events, OUTER_TASK_ID).at(-1);
        assert.equal(nested?.status, "completed");
        assert.equal(nested?.result, "NESTED_DONE");
        assert.equal(nested?.parentNodeId, outer?.id, "the nested subagent hangs off its owner");
        assert.deepEqual(subagentNodeStatuses(harness.events, NESTED_TASK_ID), [
          "running",
          "completed",
        ]);
        assert.equal(subagentCardStatuses(harness.events, NESTED_TASK_ID).at(-1), "completed");
        assert.equal(outer?.status, "running");
        // No continuation run was needed for it.
        assert.lengthOf(harness.continuationRequests, 0);
        assert.equal(harness.terminalCount(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  const REVIEW_TASK_ID = "task-subagent-end-review";
  const REVIEW_TOOL_USE_ID = "toolu-subagent-end-review";
  const REVIEW_DESCRIPTION = "Review swap undo diff";
  const REVIEW_SUMMARY = "The swap undo diff is safe.";
  const REVIEW_BASH = "toolu-subagent-end-review-bash";
  const AUDIT_TASK_ID = "task-subagent-end-audit";
  const AUDIT_TOOL_USE_ID = "toolu-subagent-end-audit";

  // Two background subagents run past the root turn; the review keeps a Bash
  // call open when the turn settles.
  const launchBackgroundSubagents = (harness: Effect.Success<typeof makeHarness>) =>
    Effect.gen(function* () {
      yield* harness.startTurn({ attemptId: LAUNCH_ATTEMPT, providerTurnOrdinal: 1 });
      for (const frame of [
        subagentStartedFrame({
          taskId: REVIEW_TASK_ID,
          toolUseId: REVIEW_TOOL_USE_ID,
          description: REVIEW_DESCRIPTION,
          uuid: "00000000-0000-4000-8000-000000000d01",
        }),
        subagentStartedFrame({
          taskId: AUDIT_TASK_ID,
          toolUseId: AUDIT_TOOL_USE_ID,
          description: "Audit recent commits",
          uuid: "00000000-0000-4000-8000-000000000d02",
        }),
        subagentToolUseFrame({
          parentToolUseId: REVIEW_TOOL_USE_ID,
          toolUseId: REVIEW_BASH,
          name: "Bash",
          toolInput: { command: "git log -5" },
          uuid: "00000000-0000-4000-8000-000000000d03",
        }),
        resultFrame({
          uuid: "00000000-0000-4000-8000-000000000d04",
          result: "Both reviews run in the background.",
        }),
      ]) {
        yield* Queue.offer(harness.sdkMessages, frame);
      }
      yield* harness.awaitEvent(isTurnTerminal);
    });

  // The review ends while no turn runs; the audit's next progress marks when
  // that end is recorded.
  const endReviewWhileIdle = (harness: Effect.Success<typeof makeHarness>) =>
    Effect.gen(function* () {
      yield* harness.offerAndWait(
        subagentEndedFrame({
          taskId: REVIEW_TASK_ID,
          toolUseId: REVIEW_TOOL_USE_ID,
          summary: REVIEW_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000d05",
        }),
      );
      yield* harness.offerAndWait(
        subagentProgressFrame({
          taskId: AUDIT_TASK_ID,
          toolUseId: AUDIT_TOOL_USE_ID,
          description: "Reading the last commits",
          uuid: "00000000-0000-4000-8000-000000000d06",
        }),
      );
      yield* harness.awaitEvent(isProgressEvent("Reading the last commits"));
    });

  it.effect("completes a background subagent's card at once and still offers its wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* launchBackgroundSubagents(harness);
        assert.equal(subagentUpdates(harness.events, REVIEW_TASK_ID).at(-1)?.status, "running");

        yield* endReviewWhileIdle(harness);

        const review = subagentUpdates(harness.events, REVIEW_TASK_ID).at(-1);
        assert.equal(review?.status, "completed");
        assert.equal(review?.result, REVIEW_SUMMARY);
        assert.deepEqual(subagentNodeStatuses(harness.events, REVIEW_TASK_ID), [
          "running",
          "completed",
        ]);
        assert.equal(subagentCardStatuses(harness.events, REVIEW_TASK_ID).at(-1), "completed");
        // A call it left open never returns once it ends.
        assert.deepEqual(toolCallStatuses(harness.events, REVIEW_BASH), [
          "command_execution:running",
          "command_execution:failed",
        ]);
        assert.equal(subagentUpdates(harness.events, AUDIT_TASK_ID).at(-1)?.status, "running");
        // The root still wakes for it, named as before, and no run has started yet.
        assert.lengthOf(harness.continuationRequests, 1);
        assert.equal(harness.continuationRequests[0]?.detail, REVIEW_SUMMARY);
        const childThreadId = review?.childThreadId ?? undefined;
        assert.isString(childThreadId);
        assert.deepEqual(harness.continuationRequests[0]?.notification, {
          source: { kind: "subagent", childThreadId },
          outcome: "completed",
          summary: `Subagent "${REVIEW_DESCRIPTION}" finished`,
        });
        assert.equal(harness.terminalCount(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("leaves the completed card alone when the continuation drains that end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* launchBackgroundSubagents(harness);
        yield* endReviewWhileIdle(harness);
        const shownAtEnd = subagentUpdates(harness.events, REVIEW_TASK_ID).at(-1);
        assert.equal(shownAtEnd?.status, "completed");

        // Claude's wake turn ends; the continuation run drains the wake buffer,
        // which still holds the review's notification.
        yield* harness.offerAndWait(
          resultFrame({
            uuid: "00000000-0000-4000-8000-000000000d07",
            result: "The review finished.",
          }),
        );
        yield* harness.startTurn({
          attemptId: CONTINUATION_ATTEMPT,
          providerTurnOrdinal: 2,
          continuation: true,
        });
        yield* harness.awaitEvent(isTurnTerminal);
        assert.equal(harness.terminalCount(), 2);
        assert.lengthOf(harness.continuationRequests, 1);

        const continuationStart = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.runAttemptId === CONTINUATION_ATTEMPT,
        );
        assert.isAtLeast(continuationStart, 0);
        // The drained end neither re-opens the card nor stores it again, and
        // the review's ended call is not ended twice.
        assert.isFalse(
          harness.events
            .slice(continuationStart)
            .some((event) => touchesSubagent(event, REVIEW_TASK_ID, shownAtEnd?.childThreadId)),
        );
        const reviewUpdates = subagentUpdates(harness.events, REVIEW_TASK_ID);
        const reviewStatuses = withoutRepeats(reviewUpdates.map((task) => task.status));
        assert.deepEqual(reviewStatuses, ["running", "completed"]);
        assert.deepEqual(subagentNodeStatuses(harness.events, REVIEW_TASK_ID), [
          "running",
          "completed",
        ]);
        assert.deepEqual(toolCallStatuses(harness.events, REVIEW_BASH), [
          "command_execution:running",
          "command_execution:failed",
        ]);
        assert.deepEqual(reviewUpdates.at(-1), shownAtEnd);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("ends a subagent resumed between turns only after the drain re-opens it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SEND_TOOL_USE_ID = "toolu-subagent-end-review-sendmessage";
        const RESUME_PROMPT = "Check the undo path again.";
        const RESUMED_SUMMARY = "The undo path is safe too.";
        const harness = yield* makeHarness;
        yield* launchBackgroundSubagents(harness);
        // The first end is shown at once.
        yield* endReviewWhileIdle(harness);
        assert.equal(subagentUpdates(harness.events, REVIEW_TASK_ID).at(-1)?.status, "completed");

        // Still between turns, the audit resumes the review with SendMessage.
        // The resume's task_started waits in the wake buffer, and so does the
        // resumed run's end that follows it.
        for (const frame of [
          subagentToolUseFrame({
            parentToolUseId: AUDIT_TOOL_USE_ID,
            toolUseId: SEND_TOOL_USE_ID,
            name: "SendMessage",
            toolInput: { to: REVIEW_TASK_ID, message: RESUME_PROMPT },
            uuid: "00000000-0000-4000-8000-000000000e01",
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: REVIEW_TASK_ID,
            tool_use_id: SEND_TOOL_USE_ID,
            description: REVIEW_DESCRIPTION,
            is_backgrounded: true,
            task_type: "local_agent",
            prompt: RESUME_PROMPT,
            uuid: "00000000-0000-4000-8000-000000000e02",
            session_id: NATIVE_SESSION,
          }),
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: SEND_TOOL_USE_ID, content: "Sent." }],
            },
            parent_tool_use_id: AUDIT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000e03",
            session_id: NATIVE_SESSION,
          }),
          subagentEndedFrame({
            taskId: REVIEW_TASK_ID,
            toolUseId: SEND_TOOL_USE_ID,
            summary: RESUMED_SUMMARY,
            uuid: "00000000-0000-4000-8000-000000000e04",
          }),
          resultFrame({
            uuid: "00000000-0000-4000-8000-000000000e05",
            result: "The review finished again.",
          }),
        ]) {
          yield* harness.offerAndWait(frame);
        }

        // One continuation run drains both ends and the resume between them.
        yield* harness.startTurn({
          attemptId: CONTINUATION_ATTEMPT,
          providerTurnOrdinal: 2,
          continuation: true,
        });
        yield* harness.awaitEvent(isTurnTerminal);
        assert.equal(harness.terminalCount(), 2);
        assert.lengthOf(harness.continuationRequests, 1);

        const reviewUpdates = subagentUpdates(harness.events, REVIEW_TASK_ID);
        const finalReview = reviewUpdates.at(-1);
        assert.equal(finalReview?.status, "completed");
        assert.equal(finalReview?.result, RESUMED_SUMMARY);
        assert.deepEqual(withoutRepeats(reviewUpdates.map((task) => task.status)), [
          "running",
          "completed",
          "running",
          "completed",
        ]);
        assert.deepEqual(subagentNodeStatuses(harness.events, REVIEW_TASK_ID), [
          "running",
          "completed",
          "running",
          "completed",
        ]);
        assert.equal(subagentCardStatuses(harness.events, REVIEW_TASK_ID).at(-1), "completed");

        // The resumed run's end is applied by the drain, after the re-open.
        const isReviewUpdate = (
          event: ProviderAdapterV2Event,
        ): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
          event.type === "subagent.updated" &&
          event.subagent.nativeTaskRef?.nativeId === REVIEW_TASK_ID;
        const continuationStart = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.runAttemptId === CONTINUATION_ATTEMPT,
        );
        const reopened = harness.events.findIndex(
          (event, index) =>
            index > continuationStart &&
            isReviewUpdate(event) &&
            event.subagent.status === "running",
        );
        const resumedEnd = harness.events.findIndex(
          (event) => isReviewUpdate(event) && event.subagent.result === RESUMED_SUMMARY,
        );
        assert.isAtLeast(continuationStart, 0);
        assert.isAbove(reopened, continuationStart);
        assert.isAbove(resumedEnd, reopened);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});
