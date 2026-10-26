/**
 * T3-CUSTOM(expbkt3): appends the thread's open review comments to the agent's
 * input at turn start.
 *
 * Each open comment goes with the next provider turn once, and is then marked
 * sent; it goes again only after the user edits, replies to or reopens it, or
 * asks for a re-send. While a sent comment stays open (the agent has not marked
 * it addressed), every later turn carries a short reminder that names it
 * instead of the full block. The agent answers through `t3_reply_comment`, and
 * the user resolves. The reactor calls
 * `appendOpenThreadComments` from one marked seam; everything else here is
 * fork-owned, and nothing in this module can fail a turn — a broken read or a
 * block that does not fit logs and falls back to the user's text.
 */
import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  THREAD_COMMENT_KIND_MEANING,
  type OrchestrationSession,
  type ThreadComment,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadCommentsService } from "./ThreadCommentsService.ts";

/** Upper bound for the appended block, whatever the user typed. */
export const OPEN_THREAD_COMMENTS_MAX_CHARS = 24_000;
const QUOTE_MAX_CHARS = 1_500;
/** Bodies and replies can be 8k each; the agent only needs the gist. */
const TEXT_MAX_CHARS = 2_000;
const REPLIES_SHOWN = 3;
/** The reminder names comments by number; past this it only counts the rest. */
const REMINDER_NUMBERS_SHOWN = 20;

const INSTRUCTIONS =
  "You received review comments on your earlier messages in this session, listed below. Treat this as review work: for each comment, either make the change it asks for or answer it. Then call t3_reply_comment with that comment's id and a short reply that says what you did; pass addressed=true when it is done. Do not skip a comment. If a comment is unclear, reply with your question instead of guessing. Reply to every comment before you end your turn. Each comment is sent to you in full once, and later turns remind you of the ones still open; the user resolves comments, or sends them again in full.";

/**
 * Only the block's own tags are defused, by swapping their `<` for `‹`: a
 * quote of code or HTML must arrive as the agent wrote it, not as entities.
 */
const OWN_TAG_OPENER =
  /<(?=\/?(?:open_chat_comments_reminder|open_chat_comments|chat_comment|earlier_replies|quote|comment|reply)\b)/gi;

export function neutralizeOwnTags(text: string): string {
  return text.replace(OWN_TAG_OPENER, "‹");
}

function attribute(value: string | number): string {
  return `"${String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"`;
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [clipped ${text.length - maxChars} more characters]`;
}

function renderComment(comment: ThreadComment): string {
  const body = comment.body.trim();
  const note = body.length > 0 ? body : THREAD_COMMENT_KIND_MEANING[comment.kind];
  const lines = [
    `<chat_comment id=${attribute(comment.commentId)} number=${attribute(comment.number)} kind=${attribute(comment.kind)} messageId=${attribute(comment.anchor.messageId)}>`,
    `<quote>${neutralizeOwnTags(clip(comment.anchor.text, QUOTE_MAX_CHARS))}</quote>`,
    `<comment>${neutralizeOwnTags(clip(note, TEXT_MAX_CHARS))}</comment>`,
  ];
  const replies = comment.replies.slice(-REPLIES_SHOWN);
  if (comment.replies.length > replies.length) {
    lines.push(`<earlier_replies omitted=${attribute(comment.replies.length - replies.length)} />`);
  }
  for (const reply of replies) {
    lines.push(
      `<reply author=${attribute(reply.author)}>${neutralizeOwnTags(clip(reply.body.trim(), TEXT_MAX_CHARS))}</reply>`,
    );
  }
  lines.push("</chat_comment>");
  return lines.join("\n");
}

/**
 * Renders open comments as one block the agent can parse. Oldest first, but
 * when the block would exceed `maxChars` the oldest are dropped and the block
 * says how many; the newest comments are the ones most likely to be live.
 * Returns `null` when not even the newest comment fits, so the caller can
 * leave the input alone instead of sending a truncated block.
 */
export function formatOpenThreadCommentsForAgent(
  comments: ReadonlyArray<ThreadComment>,
  options: { readonly maxChars?: number } = {},
): string | null {
  return renderOpenThreadComments(comments, options)?.block ?? null;
}

/** The block plus the comments it kept, so only those are marked sent. */
function renderOpenThreadComments(
  comments: ReadonlyArray<ThreadComment>,
  options: { readonly maxChars?: number },
): { readonly block: string; readonly kept: ReadonlyArray<ThreadComment> } | null {
  if (comments.length === 0) return null;
  const maxChars = options.maxChars ?? OPEN_THREAD_COMMENTS_MAX_CHARS;
  const header = (count: number, omitted: number) =>
    `<open_chat_comments count=${attribute(count)}${omitted > 0 ? ` omitted=${attribute(omitted)}` : ""}>\n${INSTRUCTIONS}${
      omitted > 0
        ? `\nOnly the newest ${count} of ${count + omitted} open comments fit here; call t3_list_comments for the rest.`
        : ""
    }`;
  const footer = "</open_chat_comments>";

  const kept: Array<string> = [];
  // Budget against the longer header, the one that carries the omitted note.
  let used = header(comments.length, comments.length).length + footer.length + 2;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const rendered = renderComment(comments[index]!);
    if (used + rendered.length + 1 > maxChars) break;
    kept.unshift(rendered);
    used += rendered.length + 1;
  }
  if (kept.length === 0) return null;
  const omitted = comments.length - kept.length;
  const block = [header(kept.length, omitted), ...kept, footer].join("\n");
  return block.length <= maxChars ? { block, kept: comments.slice(omitted) } : null;
}

/**
 * The short nudge for open comments the agent already received in full: it
 * names them by number and points at `t3_list_comments` instead of repeating
 * their text, so it stays a few hundred characters on every turn.
 */
export function formatOpenThreadCommentsReminder(
  comments: ReadonlyArray<ThreadComment>,
  options: { readonly alongsideNewComments?: boolean } = {},
): string | null {
  if (comments.length === 0) return null;
  const shown = comments.slice(0, REMINDER_NUMBERS_SHOWN).map((comment) => `#${comment.number}`);
  const more = comments.length - shown.length;
  const numbers = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const single = comments.length === 1;
  const noun = single ? "review comment is" : "review comments are";
  const them = single ? "it" : "them";
  const alongside = options.alongsideNewComments ? ", in addition to the new comments above" : "";
  return [
    `<open_chat_comments_reminder count=${attribute(comments.length)}>`,
    `Reminder: ${comments.length} ${noun} still open in this session: ${numbers}. You received ${them} in an earlier turn${alongside}. Keep working toward resolving ${them} along with this message: make the change each one asks for, or answer it, then call t3_reply_comment with its id and addressed=true. Call t3_list_comments to read them again. If you already replied and wait for the user's answer, do not reply again.`,
    "</open_chat_comments_reminder>",
  ].join("\n");
}

/** A send while a real turn is running steers that turn rather than starting one. */
function isSteeringRunningTurn(
  session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null | undefined,
): boolean {
  return session?.status === "running" && session.activeTurnId !== null;
}

/** The provider input, and the step that records which comments it carried. */
export interface PreparedThreadComments {
  readonly text: string;
  /**
   * Marks the comments in `text` sent. Run it only once the provider turn has
   * started: a turn that never starts must leave them unsent, so they go next
   * time. Never fails; a failed mark only means they go again.
   */
  readonly markSent: Effect.Effect<void>;
}

/**
 * The user's text with the thread's unsent open comments appended, followed by
 * a short reminder of the open comments already sent. The text stays unchanged
 * when nothing is open, the message steers a running turn (the block already
 * went out with that turn), the service is not wired (isolated upstream
 * reactor tests), nothing fits the provider's input limit, or the read fails.
 * When the full block does not fit, the reminder still goes if it fits.
 */
export const prepareOpenThreadComments = (
  threadId: ThreadId,
  text: string,
  session?: Pick<OrchestrationSession, "status" | "activeTurnId"> | null,
): Effect.Effect<PreparedThreadComments> => {
  const unchanged: PreparedThreadComments = { text, markSent: Effect.void };
  return Effect.gen(function* () {
    const service = yield* Effect.serviceOption(ThreadCommentsService);
    if (Option.isNone(service)) return unchanged;
    if (isSteeringRunningTurn(session)) return unchanged;
    const { unsent, alreadySent } = yield* service.value.deliveryState(threadId);
    if (unsent.length === 0 && alreadySent.length === 0) return unchanged;

    const separator = text.length === 0 ? "" : "\n\n";
    const room = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - text.length - separator.length;
    const reminder = formatOpenThreadCommentsReminder(alreadySent, {
      alongsideNewComments: unsent.length > 0,
    });
    const reminderRoom = reminder === null ? 0 : reminder.length + 1;
    const rendered =
      unsent.length > 0 && room - reminderRoom > 0
        ? renderOpenThreadComments(unsent, {
            maxChars: Math.min(OPEN_THREAD_COMMENTS_MAX_CHARS, room - reminderRoom),
          })
        : null;
    const appended = [rendered?.block ?? null, reminder]
      .filter((part): part is string => part !== null)
      .join("\n");
    if (unsent.length > 0 && rendered === null) {
      yield* Effect.logWarning("thread comments skipped: no room left in the turn input", {
        threadId,
        openComments: unsent.length,
        textLength: text.length,
      });
    }
    if (appended.length === 0 || appended.length > room) return unchanged;
    yield* Effect.logInfo("thread comments appended to turn input", {
      threadId,
      openComments: rendered?.kept.length ?? 0,
      remindedComments: alreadySent.length,
      blockLength: appended.length,
    });
    const result = `${text}${separator}${appended}`;
    if (rendered === null) return { text: result, markSent: Effect.void };
    // Only the comments read here, unchanged since: a reply that lands in
    // between keeps its comment unsent, so the reply still reaches the agent.
    const markSent = service.value.markSent({ threadId, comments: rendered.kept }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("thread comments could not be marked sent", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    return { text: result, markSent } satisfies PreparedThreadComments;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread comments could not be appended to the turn input", {
        threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(unchanged)),
    ),
  );
};

/** `prepareOpenThreadComments`, marking the comments sent at once. */
export const appendOpenThreadComments = (
  threadId: ThreadId,
  text: string,
  session?: Pick<OrchestrationSession, "status" | "activeTurnId"> | null,
): Effect.Effect<string> =>
  prepareOpenThreadComments(threadId, text, session).pipe(
    Effect.tap((prepared) => prepared.markSent),
    Effect.map((prepared) => prepared.text),
  );
