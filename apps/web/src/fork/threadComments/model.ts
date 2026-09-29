/**
 * T3-CUSTOM(expbkt3): pure derivations for review comments on agent messages.
 *
 * Every surface (selection toolbar, message highlights, side panel, composer
 * strip, send gate) reads the same snapshot; this module turns it into the few
 * facts they render, so the DOM-bound components stay thin and the rules are
 * testable without a browser.
 */
import type {
  ThreadComment,
  ThreadCommentAnchor,
  ThreadCommentKind,
  ThreadCommentsSnapshot,
} from "@t3tools/contracts";

export const THREAD_COMMENT_KINDS: ReadonlyArray<ThreadCommentKind> = [
  "comment",
  "good",
  "okay",
  "remove",
];

/** Toolbar label and the one-line meaning the panel shows for a bare reaction. */
export const THREAD_COMMENT_KIND_LABEL: Record<ThreadCommentKind, string> = {
  comment: "Comment",
  good: "Good",
  okay: "Okay",
  remove: "Remove",
};

export const THREAD_COMMENT_KIND_NOTE: Record<ThreadCommentKind, string> = {
  comment: "",
  good: "Looks good.",
  okay: "Okay.",
  remove: "Remove this.",
};

/** What a card shows in its state badge. `addressed` waits on the user to resolve. */
export type ThreadCommentDisplayState = "open" | "agent-replied" | "addressed" | "resolved";

export function deriveCommentDisplayState(
  comment: Pick<ThreadComment, "status" | "replies">,
): ThreadCommentDisplayState {
  if (comment.status === "resolved") return "resolved";
  if (comment.status === "addressed") return "addressed";
  return comment.replies.at(-1)?.author === "agent" ? "agent-replied" : "open";
}

export const THREAD_COMMENT_STATE_LABEL: Record<ThreadCommentDisplayState, string> = {
  open: "Open",
  "agent-replied": "Agent replied",
  addressed: "Addressed",
  resolved: "Resolved",
};

export type ThreadCommentsFilter = "open" | "resolved" | "all";

/** `open` shows everything still waiting on someone, including addressed comments. */
export function filterComments<C extends Pick<ThreadComment, "status">>(
  comments: ReadonlyArray<C>,
  filter: ThreadCommentsFilter,
): C[] {
  switch (filter) {
    case "open":
      return comments.filter((comment) => comment.status !== "resolved");
    case "resolved":
      return comments.filter((comment) => comment.status === "resolved");
    case "all":
      return [...comments];
  }
}

export interface ThreadCommentCounts {
  readonly open: number;
  readonly addressed: number;
  readonly resolved: number;
  /** Comments the agent will receive on the next turn. */
  readonly deliverable: number;
}

export function countComments(
  comments: ReadonlyArray<Pick<ThreadComment, "status">>,
): ThreadCommentCounts {
  let open = 0;
  let addressed = 0;
  let resolved = 0;
  for (const comment of comments) {
    if (comment.status === "open") open += 1;
    else if (comment.status === "addressed") addressed += 1;
    else resolved += 1;
  }
  return { open, addressed, resolved, deliverable: open };
}

export function formatCommentsHeader(counts: ThreadCommentCounts): string {
  const parts = [`${counts.open} open`];
  if (counts.addressed > 0) parts.push(`${counts.addressed} addressed`);
  parts.push(`${counts.resolved} resolved`);
  return parts.join(" · ");
}

export interface ThreadCommentMessageGroup {
  readonly messageId: string;
  /** Header shown above the group's cards. */
  readonly label: string;
  /** Position in the thread's message order; groups sort by it, unknown messages last. */
  readonly order: number;
  readonly comments: ThreadComment[];
}

/**
 * Cards group under the assistant message they quote, in thread order. A
 * message counts turns by the user messages before it, which is the number the
 * user sees in the transcript; a message the client has not loaded (an older
 * page) is labelled by its id fragment and sorted to the end.
 */
export function groupCommentsByMessage(
  comments: ReadonlyArray<ThreadComment>,
  messages: ReadonlyArray<{ readonly id: string; readonly role: string }>,
  providerLabel: string | null = null,
): ThreadCommentMessageGroup[] {
  const orderById = new Map<string, { order: number; turn: number }>();
  let turn = 0;
  messages.forEach((message, index) => {
    if (message.role === "user") turn += 1;
    orderById.set(message.id, { order: index, turn });
  });
  const groups = new Map<string, ThreadCommentMessageGroup & { comments: ThreadComment[] }>();
  for (const comment of comments) {
    const messageId = comment.anchor.messageId;
    let group = groups.get(messageId);
    if (!group) {
      const position = orderById.get(messageId);
      const turnLabel =
        position === undefined
          ? `Message ${messageId.slice(0, 8)}`
          : `Turn ${Math.max(1, position.turn)}`;
      group = {
        messageId,
        label: providerLabel ? `${turnLabel} · ${providerLabel}` : turnLabel,
        order: position?.order ?? Number.MAX_SAFE_INTEGER,
        comments: [],
      };
      groups.set(messageId, group);
    }
    group.comments.push(comment);
  }
  return [...groups.values()].sort((left, right) =>
    left.order === right.order
      ? left.comments[0]!.number - right.comments[0]!.number
      : left.order - right.order,
  );
}

/** Text of the strip above the composer, or null when the strip stays hidden. */
export function composerStripText(input: {
  readonly openCount: number;
  readonly deliveryPaused: boolean;
}): string | null {
  if (input.openCount <= 0) return null;
  const noun = input.openCount === 1 ? "comment" : "comments";
  return input.deliveryPaused
    ? `${input.openCount} open ${noun} paused — not sent`
    : `${input.openCount} open ${noun} will be sent with your next message`;
}

/** An empty message is a valid send when open comments will travel with it. */
export function allowsEmptySend(input: {
  readonly enabled: boolean;
  readonly openCount: number;
  readonly deliveryPaused: boolean;
}): boolean {
  return input.enabled && input.openCount > 0 && !input.deliveryPaused;
}

/** What goes out as the message when the user sends nothing but open comments. */
export const THREAD_COMMENTS_EMPTY_SEND_TEXT = "Please work through the open review comments.";

export const THREAD_COMMENT_PLACEHOLDER =
  "Ask for follow-up changes, or press Send to have the agent work through the comments…";

export const THREAD_COMMENT_HIGHLIGHT_PREFIX = "t3-thread-comment-";

/**
 * Which CSS custom highlight a comment's quote joins. Resolved comments keep a
 * faint mark so an old quote is still findable, and `null` means no mark at
 * all (nothing today, but the seam is here for a future "hide resolved").
 */
export function highlightNameForComment(
  comment: Pick<ThreadComment, "kind" | "status">,
): string | null {
  if (comment.status === "resolved") return `${THREAD_COMMENT_HIGHLIGHT_PREFIX}resolved`;
  return `${THREAD_COMMENT_HIGHLIGHT_PREFIX}${comment.kind}`;
}

export const THREAD_COMMENT_ACTIVE_HIGHLIGHT = `${THREAD_COMMENT_HIGHLIGHT_PREFIX}active`;

export const THREAD_COMMENT_HIGHLIGHT_NAMES: ReadonlyArray<string> = [
  ...THREAD_COMMENT_KINDS.map((kind) => `${THREAD_COMMENT_HIGHLIGHT_PREFIX}${kind}`),
  `${THREAD_COMMENT_HIGHLIGHT_PREFIX}resolved`,
  THREAD_COMMENT_ACTIVE_HIGHLIGHT,
];

/** Comments whose quote lives in one message, oldest first. */
export function commentsForMessage(
  snapshot: Pick<ThreadCommentsSnapshot, "comments"> | null,
  messageId: string,
): ThreadComment[] {
  if (snapshot === null) return [];
  return snapshot.comments.filter((comment) => comment.anchor.messageId === messageId);
}

/** The selection toolbar's capture already has every anchor field but the message. */
export function buildCommentAnchor(
  messageId: ThreadCommentAnchor["messageId"],
  selector: Omit<ThreadCommentAnchor, "messageId">,
): ThreadCommentAnchor {
  return {
    messageId,
    text: selector.text,
    start: selector.start,
    end: selector.end,
    prefix: selector.prefix,
    suffix: selector.suffix,
  };
}

/** One-line quote for a card, with the whitespace the message rendered collapsed. */
export function quotePreview(text: string, maxChars = 140): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}
