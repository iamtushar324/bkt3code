/**
 * T3-CUSTOM(expbkt3): access checks on the review-comment websocket RPCs.
 *
 * Every method is thread-scoped, and a denied thread must read exactly like a
 * missing one; the actor stamped onto a comment must be the connection's user.
 */
import {
  EnvironmentAuthorizationError,
  MessageId,
  OrchestrationGetSnapshotError,
  ThreadCommentId,
  ThreadCommentsError,
  ThreadId,
  UserId,
  WS_FORK_METHODS,
  type ThreadCommentsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as ThreadCommentsService from "./threadcomments/ThreadCommentsService.ts";
import { makeForkWsHandlers, type ForkWsHandlerDeps } from "./wsForkHandlers.ts";

const visibleThreadId = ThreadId.make("thread-visible");
const hiddenThreadId = ThreadId.make("thread-hidden");
const actorUserId = UserId.make("user-reviewer");
const commentId = ThreadCommentId.make("tc_1");

const snapshotFor = (threadId: ThreadId): ThreadCommentsSnapshot => ({
  threadId,
  comments: [],
  deliveryPaused: false,
});

function makeHandlers() {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  // Recording happens when the effect runs, not when it is built: the handler
  // composes the service call under the access guard before anything runs.
  const record =
    (method: string) =>
    <A>(value: A) =>
    (input: unknown) =>
      Effect.sync(() => {
        calls.push({ method, input });
        return value;
      });
  const threadComments = {
    snapshot: record("snapshot")(snapshotFor(visibleThreadId)),
    add: record("add")(snapshotFor(visibleThreadId)),
    reply: record("reply")(snapshotFor(visibleThreadId)),
    setStatus: record("setStatus")(snapshotFor(visibleThreadId)),
    resolveAll: record("resolveAll")(snapshotFor(visibleThreadId)),
    remove: record("remove")(snapshotFor(visibleThreadId)),
    setDeliveryPaused: record("setDeliveryPaused")(snapshotFor(visibleThreadId)),
    agentReply: () => Effect.die("unused"),
    openForDelivery: () => Effect.die("unused"),
    watch: (threadId: ThreadId) =>
      Stream.fromEffect(
        Effect.sync(() => {
          calls.push({ method: "watch", input: threadId });
          return snapshotFor(threadId);
        }),
      ),
  } satisfies ThreadCommentsService.ThreadCommentsServiceShape;

  const deps = {
    actorUserId,
    actorLabel: "Barsha",
    threadComments,
    observeRpcEffect: (_method, effect) => effect,
    observeRpcStream: (_method, stream) => stream,
    requireThreadAccess: (threadId) =>
      threadId === visibleThreadId
        ? Effect.void
        : Effect.fail(
            new OrchestrationGetSnapshotError({ message: `Thread '${threadId}' was not found.` }),
          ),
  } satisfies Partial<ForkWsHandlerDeps>;

  return { handlers: makeForkWsHandlers(deps as unknown as ForkWsHandlerDeps), calls };
}

const anchor = {
  messageId: MessageId.make("message-1"),
  text: "quoted",
  start: 0,
  end: 6,
  prefix: "",
  suffix: "",
};

describe("thread comment websocket handlers", () => {
  it.effect("denies every mutation and read on a thread the caller cannot access", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers();
      const attempts: ReadonlyArray<
        readonly [
          string,
          Effect.Effect<unknown, ThreadCommentsError | EnvironmentAuthorizationError>,
        ]
      > = [
        [
          WS_FORK_METHODS.threadCommentsList,
          handlers[WS_FORK_METHODS.threadCommentsList]({ threadId: hiddenThreadId }),
        ],
        [
          WS_FORK_METHODS.threadCommentsAdd,
          handlers[WS_FORK_METHODS.threadCommentsAdd]({
            threadId: hiddenThreadId,
            kind: "comment",
            anchor,
            body: "x",
          }),
        ],
        [
          WS_FORK_METHODS.threadCommentsReply,
          handlers[WS_FORK_METHODS.threadCommentsReply]({
            threadId: hiddenThreadId,
            commentId,
            body: "x",
          }),
        ],
        [
          WS_FORK_METHODS.threadCommentsSetStatus,
          handlers[WS_FORK_METHODS.threadCommentsSetStatus]({
            threadId: hiddenThreadId,
            commentId,
            status: "resolved",
          }),
        ],
        [
          WS_FORK_METHODS.threadCommentsResolveAll,
          handlers[WS_FORK_METHODS.threadCommentsResolveAll]({ threadId: hiddenThreadId }),
        ],
        [
          WS_FORK_METHODS.threadCommentsRemove,
          handlers[WS_FORK_METHODS.threadCommentsRemove]({ threadId: hiddenThreadId, commentId }),
        ],
        [
          WS_FORK_METHODS.threadCommentsSetDeliveryPaused,
          handlers[WS_FORK_METHODS.threadCommentsSetDeliveryPaused]({
            threadId: hiddenThreadId,
            paused: true,
          }),
        ],
        [
          WS_FORK_METHODS.subscribeThreadComments,
          Stream.runCollect(
            handlers[WS_FORK_METHODS.subscribeThreadComments]({ threadId: hiddenThreadId }),
          ),
        ],
      ];
      for (const [method, attempt] of attempts) {
        const error = yield* Effect.flip(Effect.asVoid(attempt));
        expect(error, method).toBeInstanceOf(ThreadCommentsError);
        expect(error._tag === "ThreadCommentsError" ? error.reason : error._tag, method).toBe(
          "not-found",
        );
      }
      expect(calls).toEqual([]);
    }),
  );

  it.effect("stamps the connection's actor onto comments and replies", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers();
      yield* handlers[WS_FORK_METHODS.threadCommentsAdd]({
        threadId: visibleThreadId,
        kind: "good",
        anchor,
        body: "",
      });
      yield* handlers[WS_FORK_METHODS.threadCommentsReply]({
        threadId: visibleThreadId,
        commentId,
        body: "thanks",
      });
      expect(calls).toEqual([
        {
          method: "add",
          input: {
            threadId: visibleThreadId,
            kind: "good",
            anchor,
            body: "",
            actorUserId,
            actorLabel: "Barsha",
          },
        },
        {
          method: "reply",
          input: {
            threadId: visibleThreadId,
            commentId,
            body: "thanks",
            actorUserId,
            actorLabel: "Barsha",
          },
        },
      ]);
    }),
  );

  it.effect("forwards the resolve-all scope to the service", () =>
    Effect.gen(function* () {
      const { handlers, calls } = makeHandlers();
      yield* handlers[WS_FORK_METHODS.threadCommentsResolveAll]({
        threadId: visibleThreadId,
        only: "addressed",
      });
      yield* handlers[WS_FORK_METHODS.threadCommentsResolveAll]({ threadId: visibleThreadId });
      expect(calls).toEqual([
        { method: "resolveAll", input: { threadId: visibleThreadId, only: "addressed" } },
        { method: "resolveAll", input: { threadId: visibleThreadId } },
      ]);
    }),
  );

  it.effect("streams snapshots for an accessible thread", () =>
    Effect.gen(function* () {
      const { handlers } = makeHandlers();
      const snapshots = yield* Stream.runCollect(
        handlers[WS_FORK_METHODS.subscribeThreadComments]({ threadId: visibleThreadId }),
      );
      expect(snapshots).toEqual([snapshotFor(visibleThreadId)]);
    }),
  );
});
