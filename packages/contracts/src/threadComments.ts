/**
 * T3-CUSTOM(expbkt3): review comments on agent messages in the main chat.
 *
 * A user selects text in an assistant message and leaves a comment, or one of
 * three one-click reactions (good / okay / remove). Open comments are active
 * instructions for the session: the server appends them to the agent's input on
 * every turn until the agent marks them addressed or the user resolves them.
 * Only the user resolves; the agent may reply and mark a comment addressed.
 *
 * Comments live in a fork-owned table and travel on fork RPCs, so upstream
 * orchestration contracts are untouched. The quote anchor reuses the upstream
 * assistant-citation selector (UTF-16 offsets into the rendered message text
 * plus a little surrounding context), so highlighting shares its machinery.
 */
import * as Schema from "effect/Schema";

import { MessageId, NonNegativeInt, PositiveInt, ThreadId, UserId } from "./baseSchemas.ts";

export const THREAD_COMMENT_MAX_QUOTE_LENGTH = 8_000;
export const THREAD_COMMENT_MAX_BODY_LENGTH = 8_000;
export const THREAD_COMMENT_CONTEXT_LENGTH = 32;
/** Replies kept per comment; older ones are dropped from the head. */
export const THREAD_COMMENT_MAX_REPLIES = 50;

/**
 * - `comment`: free text.
 * - `good`: keep this as it is.
 * - `okay`: acceptable as it is, no change needed.
 * - `remove`: drop this / do not do this.
 */
export const ThreadCommentKind = Schema.Literals(["comment", "good", "okay", "remove"]);
export type ThreadCommentKind = typeof ThreadCommentKind.Type;

/**
 * - `open`: sent to the agent with every turn.
 * - `addressed`: the agent says it is done; waits for the user to resolve. Not re-sent.
 * - `resolved`: closed by the user. Not re-sent.
 */
export const ThreadCommentStatus = Schema.Literals(["open", "addressed", "resolved"]);
export type ThreadCommentStatus = typeof ThreadCommentStatus.Type;

export const ThreadCommentId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(128),
).pipe(Schema.brand("ThreadCommentId"));
export type ThreadCommentId = typeof ThreadCommentId.Type;

const Quote = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(THREAD_COMMENT_MAX_QUOTE_LENGTH),
);
const Body = Schema.String.check(Schema.isMaxLength(THREAD_COMMENT_MAX_BODY_LENGTH));
const Context = Schema.String.check(Schema.isMaxLength(THREAD_COMMENT_CONTEXT_LENGTH));
const Offset = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));

/** Where the comment points: a quote of one assistant message's rendered text. */
export const ThreadCommentAnchor = Schema.Struct({
  messageId: MessageId.check(Schema.isMaxLength(512)),
  text: Quote,
  start: Offset,
  end: Offset,
  prefix: Context,
  suffix: Context,
}).check(Schema.makeFilter((anchor) => anchor.end > anchor.start));
export type ThreadCommentAnchor = typeof ThreadCommentAnchor.Type;

export const ThreadCommentReplyAuthor = Schema.Literals(["user", "agent"]);
export type ThreadCommentReplyAuthor = typeof ThreadCommentReplyAuthor.Type;

export const ThreadCommentReply = Schema.Struct({
  replyId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  author: ThreadCommentReplyAuthor,
  authorUserId: Schema.NullOr(UserId),
  authorLabel: Schema.NullOr(Schema.String),
  body: Body,
  createdAt: Schema.String,
});
export type ThreadCommentReply = typeof ThreadCommentReply.Type;

export const ThreadComment = Schema.Struct({
  commentId: ThreadCommentId,
  threadId: ThreadId,
  /** Per-thread display number (#1, #2, …); never reused within a thread. */
  number: PositiveInt,
  kind: ThreadCommentKind,
  anchor: ThreadCommentAnchor,
  /** Free text for `comment`; optional note for the reactions. */
  body: Body,
  status: ThreadCommentStatus,
  authorUserId: Schema.NullOr(UserId),
  authorLabel: Schema.NullOr(Schema.String),
  replies: Schema.Array(ThreadCommentReply),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  resolvedAt: Schema.NullOr(Schema.String),
});
export type ThreadComment = typeof ThreadComment.Type;

export const ThreadCommentsSnapshot = Schema.Struct({
  threadId: ThreadId,
  /** Oldest first. */
  comments: Schema.Array(ThreadComment),
  /** When true, open comments are not appended to the agent's input. */
  deliveryPaused: Schema.Boolean,
});
export type ThreadCommentsSnapshot = typeof ThreadCommentsSnapshot.Type;

export const ThreadCommentsThreadInput = Schema.Struct({ threadId: ThreadId });
export type ThreadCommentsThreadInput = typeof ThreadCommentsThreadInput.Type;

/**
 * Resolve every unresolved comment, or with `only: "addressed"` just the ones the
 * agent has marked done. Absent `only` keeps the original resolve-all behaviour.
 */
export const ThreadCommentsResolveAllInput = Schema.Struct({
  threadId: ThreadId,
  only: Schema.optional(Schema.Literal("addressed")),
});
export type ThreadCommentsResolveAllInput = typeof ThreadCommentsResolveAllInput.Type;

export const ThreadCommentsAddInput = Schema.Struct({
  threadId: ThreadId,
  kind: ThreadCommentKind,
  anchor: ThreadCommentAnchor,
  body: Body,
}).check(
  // A free-text comment needs text; a reaction's note is optional.
  Schema.makeFilter((input) => input.kind !== "comment" || input.body.trim().length > 0),
);
export type ThreadCommentsAddInput = typeof ThreadCommentsAddInput.Type;

export const ThreadCommentsReplyInput = Schema.Struct({
  threadId: ThreadId,
  commentId: ThreadCommentId,
  body: Body.check(Schema.makeFilter((body) => body.trim().length > 0)),
});
export type ThreadCommentsReplyInput = typeof ThreadCommentsReplyInput.Type;

/** A user may resolve or reopen. `addressed` is set only by the agent. */
export const ThreadCommentsSetStatusInput = Schema.Struct({
  threadId: ThreadId,
  commentId: ThreadCommentId,
  status: Schema.Literals(["open", "resolved"]),
});
export type ThreadCommentsSetStatusInput = typeof ThreadCommentsSetStatusInput.Type;

export const ThreadCommentsRemoveInput = Schema.Struct({
  threadId: ThreadId,
  commentId: ThreadCommentId,
});
export type ThreadCommentsRemoveInput = typeof ThreadCommentsRemoveInput.Type;

export const ThreadCommentsSetDeliveryPausedInput = Schema.Struct({
  threadId: ThreadId,
  paused: Schema.Boolean,
});
export type ThreadCommentsSetDeliveryPausedInput = typeof ThreadCommentsSetDeliveryPausedInput.Type;

export const ThreadCommentsErrorReason = Schema.Literals(["not-found", "invalid", "internal"]);
export type ThreadCommentsErrorReason = typeof ThreadCommentsErrorReason.Type;

export class ThreadCommentsError extends Schema.TaggedError<ThreadCommentsError>()(
  "ThreadCommentsError",
  {
    operation: Schema.String,
    reason: ThreadCommentsErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Thread comments ${this.operation} failed: ${this.detail}`;
  }
}

/** Default text the agent reads for a reaction left without a note. */
export const THREAD_COMMENT_KIND_MEANING: Record<ThreadCommentKind, string> = {
  comment: "Comment",
  good: "Looks good; keep this as it is.",
  okay: "Acceptable as it is; no change needed.",
  remove: "Remove this; do not do it.",
};

export function isThreadCommentDeliverable(comment: Pick<ThreadComment, "status">): boolean {
  return comment.status === "open";
}
