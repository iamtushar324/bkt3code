/**
 * T3-CUSTOM(expbkt3): review comments on assistant messages in the main chat.
 *
 * One fork-owned service carries every side of the feature: the sidebar's
 * snapshot and live stream, the user's mutations from the websocket handlers,
 * the agent's replies from the MCP tools, and the turn-start read that decides
 * what to append to the agent's input. Keeping the status rules here (who may
 * reopen, when a reply reopens, what counts as deliverable) means the three
 * callers cannot drift apart.
 */
import {
  THREAD_COMMENT_MAX_REPLIES,
  ThreadCommentsError,
  isThreadCommentDeliverable,
  type ThreadComment,
  type ThreadCommentId,
  type ThreadCommentsAddInput,
  type ThreadCommentsRemoveInput,
  type ThreadCommentsReplyInput,
  type ThreadCommentsSetDeliveryPausedInput,
  type ThreadCommentsSetStatusInput,
  type ThreadCommentsSnapshot,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ThreadCommentsRepository } from "../persistence/ThreadComments.ts";

/** Who is acting: the connection's user, stamped onto comments and replies. */
export interface ThreadCommentActor {
  readonly actorUserId: UserId | null;
  readonly actorLabel: string | null;
}

export interface AgentReplyInput {
  readonly threadId: ThreadId;
  readonly commentId: ThreadCommentId;
  readonly body?: string | undefined;
  /** `true` marks the comment addressed; `false` or absent leaves the status alone. */
  readonly addressed?: boolean | undefined;
}

export interface ThreadCommentsServiceShape {
  readonly snapshot: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  readonly add: (
    input: ThreadCommentsAddInput & ThreadCommentActor,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  /** A user reply; on an `addressed` comment it reopens the comment. */
  readonly reply: (
    input: ThreadCommentsReplyInput & ThreadCommentActor,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  readonly setStatus: (
    input: ThreadCommentsSetStatusInput,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  /** Resolves every open and addressed comment on the thread. */
  readonly resolveAll: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  readonly remove: (
    input: ThreadCommentsRemoveInput,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  readonly setDeliveryPaused: (
    input: ThreadCommentsSetDeliveryPausedInput,
  ) => Effect.Effect<ThreadCommentsSnapshot, ThreadCommentsError>;
  /** The agent's side: an optional reply and/or marking the comment addressed. */
  readonly agentReply: (
    input: AgentReplyInput,
  ) => Effect.Effect<ThreadComment, ThreadCommentsError>;
  /** Comments to append to the agent's next input: open ones, unless paused. */
  readonly openForDelivery: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ThreadComment>, ThreadCommentsError>;
  /**
   * Emits a snapshot on subscribe and again after every mutation from any
   * client or the agent, so open panels converge without polling.
   */
  readonly watch: (
    threadId: ThreadId,
  ) => Stream.Stream<ThreadCommentsSnapshot, ThreadCommentsError>;
}

export class ThreadCommentsService extends Context.Service<
  ThreadCommentsService,
  ThreadCommentsServiceShape
>()("t3/threadcomments/ThreadCommentsService") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const internal = (operation: string) => (cause: unknown) =>
  new ThreadCommentsError({
    operation,
    reason: "internal",
    detail: cause instanceof Error ? cause.message : String(cause),
  });

const notFound = (operation: string, commentId: string) =>
  new ThreadCommentsError({
    operation,
    reason: "not-found",
    detail: `Comment '${commentId}' was not found on this thread.`,
  });

const invalid = (operation: string, detail: string) =>
  new ThreadCommentsError({ operation, reason: "invalid", detail });

export const make = Effect.gen(function* () {
  const repository = yield* ThreadCommentsRepository;
  const crypto = yield* Crypto.Crypto;

  // A failing CSPRNG is a defect, not something a caller can recover from.
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const shortId = (prefix: string) =>
    Effect.map(uuid, (value) => `${prefix}_${value.replaceAll("-", "").slice(0, 20)}`);

  // Mutations announce the thread they touched; `watch` re-reads from there.
  const changes = yield* PubSub.unbounded<ThreadId>();
  const announce = (threadId: ThreadId) => PubSub.publish(changes, threadId).pipe(Effect.ignore);

  // Every mutation is a read-modify-write of one row. Writes are rare and
  // small, so one lock across the service is enough to keep an agent reply
  // from racing a user's resolve (and dropping either change).
  const writes = yield* Semaphore.make(1);

  const snapshot: ThreadCommentsServiceShape["snapshot"] = (threadId) =>
    Effect.gen(function* () {
      const [comments, settings] = yield* Effect.all([
        repository.listForThread(threadId),
        repository.getSettings(threadId),
      ]);
      return {
        threadId,
        comments,
        deliveryPaused: settings.deliveryPaused,
      } satisfies ThreadCommentsSnapshot;
    }).pipe(Effect.mapError(internal("snapshot")));

  const requireComment = (
    operation: string,
    threadId: ThreadId,
    commentId: ThreadCommentId,
  ): Effect.Effect<ThreadComment, ThreadCommentsError> =>
    repository.getComment({ threadId, commentId }).pipe(
      Effect.mapError(internal(operation)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(notFound(operation, commentId)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const mutate = (
    operation: string,
    threadId: ThreadId,
    body: Effect.Effect<void, ThreadCommentsError>,
  ) =>
    writes
      .withPermits(1)(body)
      .pipe(
        Effect.andThen(announce(threadId)),
        Effect.andThen(snapshot(threadId)),
        Effect.mapError((cause) =>
          cause._tag === "ThreadCommentsError" ? cause : internal(operation)(cause),
        ),
      );

  const appendReply = (
    comment: ThreadComment,
    reply: ThreadComment["replies"][number],
  ): ThreadComment["replies"] => {
    const replies = [...comment.replies, reply];
    return replies.length > THREAD_COMMENT_MAX_REPLIES
      ? replies.slice(replies.length - THREAD_COMMENT_MAX_REPLIES)
      : replies;
  };

  const add: ThreadCommentsServiceShape["add"] = (input) =>
    mutate(
      "add",
      input.threadId,
      Effect.gen(function* () {
        const body = input.body.trim();
        if (input.kind === "comment" && body.length === 0) {
          return yield* invalid("add", "A comment needs some text.");
        }
        const commentId = (yield* shortId("tc")) as ThreadCommentId;
        const number = yield* repository
          .allocateNumber(input.threadId)
          .pipe(Effect.mapError(internal("add")));
        const createdAt = yield* nowIso;
        yield* repository
          .insertComment({
            commentId,
            threadId: input.threadId,
            number,
            kind: input.kind,
            anchor: input.anchor,
            body,
            status: "open",
            authorUserId: input.actorUserId,
            authorLabel: input.actorLabel,
            replies: [],
            createdAt,
            updatedAt: createdAt,
            resolvedAt: null,
          })
          .pipe(Effect.mapError(internal("add")));
      }),
    );

  const reply: ThreadCommentsServiceShape["reply"] = (input) =>
    mutate(
      "reply",
      input.threadId,
      Effect.gen(function* () {
        const body = input.body.trim();
        if (body.length === 0) return yield* invalid("reply", "A reply needs some text.");
        const comment = yield* requireComment("reply", input.threadId, input.commentId);
        const createdAt = yield* nowIso;
        const replyId = yield* shortId("tcr");
        // The user talking back on an addressed or resolved comment means it
        // is not done: it goes back to the agent with the next turn.
        yield* repository
          .updateComment({
            ...comment,
            status: "open",
            resolvedAt: null,
            replies: appendReply(comment, {
              replyId,
              author: "user",
              authorUserId: input.actorUserId,
              authorLabel: input.actorLabel,
              body,
              createdAt,
            }),
            updatedAt: createdAt,
          })
          .pipe(Effect.mapError(internal("reply")));
      }),
    );

  const setStatus: ThreadCommentsServiceShape["setStatus"] = (input) =>
    mutate(
      "setStatus",
      input.threadId,
      Effect.gen(function* () {
        const comment = yield* requireComment("setStatus", input.threadId, input.commentId);
        if (comment.status === input.status) return;
        const updatedAt = yield* nowIso;
        yield* repository
          .updateComment({
            ...comment,
            status: input.status,
            updatedAt,
            resolvedAt: input.status === "resolved" ? updatedAt : null,
          })
          .pipe(Effect.mapError(internal("setStatus")));
      }),
    );

  const resolveAll: ThreadCommentsServiceShape["resolveAll"] = (threadId) =>
    mutate(
      "resolveAll",
      threadId,
      Effect.gen(function* () {
        const resolvedAt = yield* nowIso;
        yield* repository
          .resolveAll({ threadId, resolvedAt })
          .pipe(Effect.mapError(internal("resolveAll")));
      }),
    );

  const remove: ThreadCommentsServiceShape["remove"] = (input) =>
    mutate(
      "remove",
      input.threadId,
      Effect.gen(function* () {
        yield* requireComment("remove", input.threadId, input.commentId);
        yield* repository.deleteComment(input).pipe(Effect.mapError(internal("remove")));
      }),
    );

  const setDeliveryPaused: ThreadCommentsServiceShape["setDeliveryPaused"] = (input) =>
    mutate(
      "setDeliveryPaused",
      input.threadId,
      repository
        .setDeliveryPaused({ threadId: input.threadId, paused: input.paused })
        .pipe(Effect.mapError(internal("setDeliveryPaused"))),
    );

  const agentReply: ThreadCommentsServiceShape["agentReply"] = (input) =>
    Effect.gen(function* () {
      const body = input.body?.trim() ?? "";
      const addressed = input.addressed === true;
      if (body.length === 0 && !addressed) {
        return yield* invalid(
          "agentReply",
          "Pass a reply `body`, `addressed: true`, or both; there is nothing to record otherwise.",
        );
      }
      const updated = yield* writes.withPermits(1)(
        Effect.gen(function* () {
          const comment = yield* requireComment("agentReply", input.threadId, input.commentId);
          const createdAt = yield* nowIso;
          const replies =
            body.length === 0
              ? comment.replies
              : appendReply(comment, {
                  replyId: yield* shortId("tcr"),
                  author: "agent",
                  authorUserId: null,
                  authorLabel: null,
                  body,
                  createdAt,
                });
          // A resolved comment stays resolved: the user closed it, and the
          // agent only ever moves an open comment to addressed.
          const status =
            addressed && comment.status === "open" ? ("addressed" as const) : comment.status;
          const next: ThreadComment = { ...comment, status, replies, updatedAt: createdAt };
          yield* repository.updateComment(next).pipe(Effect.mapError(internal("agentReply")));
          return next;
        }),
      );
      yield* announce(input.threadId);
      return updated;
    });

  const openForDelivery: ThreadCommentsServiceShape["openForDelivery"] = (threadId) =>
    Effect.gen(function* () {
      const settings = yield* repository.getSettings(threadId);
      if (settings.deliveryPaused) return [];
      const comments = yield* repository.listForThread(threadId);
      return comments.filter(isThreadCommentDeliverable);
    }).pipe(Effect.mapError(internal("openForDelivery")));

  // Subscribe before the first read: a write that lands between the two is
  // then seen as a change and re-read, rather than lost until the next one.
  const watch: ThreadCommentsServiceShape["watch"] = (threadId) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        const initial = yield* snapshot(threadId);
        return Stream.concat(
          Stream.make(initial),
          Stream.fromSubscription(subscription).pipe(
            Stream.filter((changed) => changed === threadId),
            Stream.mapEffect(() => snapshot(threadId)),
          ),
        );
      }),
    );

  return ThreadCommentsService.of({
    snapshot,
    add,
    reply,
    setStatus,
    resolveAll,
    remove,
    setDeliveryPaused,
    agentReply,
    openForDelivery,
    watch,
  });
});

export const layer = Layer.effect(ThreadCommentsService, make);
