/**
 * T3-CUSTOM(expbkt3): appends the thread's open review comments to the agent's
 * input at turn start.
 *
 * Open comments are standing instructions: they ride along with every new
 * provider turn until the agent marks them addressed (through
 * `t3_reply_comment`) or the user resolves them. The reactor calls
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

const INSTRUCTIONS =
  "The user left these comments on your earlier messages in this session. Treat them as active instructions for this turn: act on each one, or answer it. When you have handled one, call t3_reply_comment with its id (addressed=true once done; a short body explaining what you did). The user resolves comments; open ones are re-sent with every new turn.";

/**
 * Only the block's own tags are defused, by swapping their `<` for `‹`: a
 * quote of code or HTML must arrive as the agent wrote it, not as entities.
 */
const OWN_TAG_OPENER =
  /<(?=\/?(?:open_chat_comments|chat_comment|earlier_replies|quote|comment|reply)\b)/gi;

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
  return block.length <= maxChars ? block : null;
}

/** A send while a real turn is running steers that turn rather than starting one. */
function isSteeringRunningTurn(
  session: Pick<OrchestrationSession, "status" | "activeTurnId"> | null | undefined,
): boolean {
  return session?.status === "running" && session.activeTurnId !== null;
}

/**
 * The user's text with the thread's open comments appended, or the text
 * unchanged when there is nothing to add, the message steers a running turn
 * (the block already went out with that turn), the service is not wired
 * (isolated upstream reactor tests), the block would not fit the provider's
 * input limit, or the read fails.
 */
export const appendOpenThreadComments = (
  threadId: ThreadId,
  text: string,
  session?: Pick<OrchestrationSession, "status" | "activeTurnId"> | null,
): Effect.Effect<string> =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(ThreadCommentsService);
    if (Option.isNone(service)) return text;
    if (isSteeringRunningTurn(session)) return text;
    const comments = yield* service.value.openForDelivery(threadId);
    if (comments.length === 0) return text;

    const separator = text.length === 0 ? "" : "\n\n";
    const room = PROVIDER_SEND_TURN_MAX_INPUT_CHARS - text.length - separator.length;
    const block =
      room > 0
        ? formatOpenThreadCommentsForAgent(comments, {
            maxChars: Math.min(OPEN_THREAD_COMMENTS_MAX_CHARS, room),
          })
        : null;
    const result = block === null ? null : `${text}${separator}${block}`;
    if (result === null || result.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
      yield* Effect.logWarning("thread comments skipped: no room left in the turn input", {
        threadId,
        openComments: comments.length,
        textLength: text.length,
      });
      return text;
    }
    yield* Effect.logInfo("thread comments appended to turn input", {
      threadId,
      openComments: comments.length,
      blockLength: block!.length,
    });
    return result;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("thread comments could not be appended to the turn input", {
        threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(text)),
    ),
  );
