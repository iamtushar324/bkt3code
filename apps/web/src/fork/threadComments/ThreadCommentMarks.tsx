/**
 * T3-CUSTOM(expbkt3): highlights and pins for the comments on one assistant message.
 *
 * Rendered as a sibling right after upstream's `AssistantCitationSource` in the
 * timeline row, whose outer element is already `position: relative`. Each
 * comment's quote is re-resolved against the rendered text with upstream's
 * citation anchoring and painted through a CSS custom highlight, with a small
 * numbered pin at the end of the range as the click target (highlights are not
 * hit-testable). Pins are absolutely positioned inside the row, so they travel
 * with the virtualised list for free; they are only recomputed when the row
 * resizes or its text mutates, never on scroll or per frame.
 */
import type { ScopedThreadRef, ThreadComment } from "@t3tools/contracts";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { resolveAssistantCitationRange } from "../../lib/assistantTextSelection";
import { useRightPanelStore } from "../../rightPanelStore";
import { highlightFor, removeRangeFromHighlights } from "./highlights";
import { useThreadCommentsEnabled, useThreadCommentsSnapshot } from "./hooks";
import {
  commentsForMessage,
  highlightNameForComment,
  THREAD_COMMENT_ACTIVE_HIGHLIGHT,
  THREAD_COMMENT_KIND_LABEL,
} from "./model";
import { useThreadCommentsUiStore } from "./uiStore";

interface Pin {
  readonly commentId: string;
  readonly number: number;
  readonly kind: ThreadComment["kind"];
  readonly top: number;
  readonly left: number;
}

const PIN_KIND_CLASS: Record<ThreadComment["kind"], string> = {
  comment: "bg-warning text-black/80",
  good: "bg-success text-white",
  okay: "bg-muted-foreground text-background",
  remove: "bg-destructive text-white",
};

function samePins(left: ReadonlyArray<Pin>, right: ReadonlyArray<Pin>): boolean {
  if (left.length !== right.length) return false;
  return left.every((pin, index) => {
    const other = right[index]!;
    return (
      pin.commentId === other.commentId &&
      pin.number === other.number &&
      pin.kind === other.kind &&
      Math.abs(pin.top - other.top) < 0.5 &&
      Math.abs(pin.left - other.left) < 0.5
    );
  });
}

export function ThreadCommentMarks({
  messageId,
  threadRef,
}: {
  messageId: string;
  threadRef: ScopedThreadRef | null;
}) {
  const enabled = useThreadCommentsEnabled(threadRef?.environmentId);
  const snapshot = useThreadCommentsSnapshot(threadRef, enabled);
  const comments = useMemo(() => commentsForMessage(snapshot, messageId), [snapshot, messageId]);
  if (threadRef === null || comments.length === 0) return null;
  return <ThreadCommentPins threadRef={threadRef} messageId={messageId} comments={comments} />;
}

const ThreadCommentPins = memo(function ThreadCommentPins({
  threadRef,
  messageId,
  comments,
}: {
  threadRef: ScopedThreadRef;
  messageId: string;
  comments: ReadonlyArray<ThreadComment>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [pins, setPins] = useState<ReadonlyArray<Pin>>([]);
  const rangesRef = useRef<ReadonlyMap<string, Range>>(new Map());
  const hoveredCommentId = useThreadCommentsUiStore((state) => state.hoveredCommentId);

  useLayoutEffect(() => {
    const host = hostRef.current;
    const container = host?.parentElement;
    const source = container?.querySelector<HTMLElement>(
      `[data-assistant-citation-source="${CSS.escape(messageId)}"]`,
    );
    if (!host || !container || !source) return;
    let frame: number | null = null;
    const clearRanges = () => {
      for (const range of rangesRef.current.values()) removeRangeFromHighlights(range);
      rangesRef.current = new Map();
    };
    const apply = () => {
      frame = null;
      clearRanges();
      // The host is inset to the container, so its rect is the pins' origin.
      const origin = host.getBoundingClientRect();
      const activeId = useThreadCommentsUiStore.getState().hoveredCommentId;
      const ranges = new Map<string, Range>();
      const next: Pin[] = [];
      for (const comment of comments) {
        const range = resolveAssistantCitationRange(source, comment.anchor);
        if (!range) continue;
        ranges.set(comment.commentId, range);
        const name = highlightNameForComment(comment);
        if (name) highlightFor(name)?.add(range);
        if (activeId === comment.commentId) {
          highlightFor(THREAD_COMMENT_ACTIVE_HIGHLIGHT)?.add(range);
        }
        // Resolved comments keep a faint highlight but no pin: a pin is a call to act.
        if (comment.status === "resolved") continue;
        const rects = range.getClientRects();
        const last = rects.item(rects.length - 1);
        if (!last) continue;
        next.push({
          commentId: comment.commentId,
          number: comment.number,
          kind: comment.kind,
          // Superscript position: centred on the line's top edge, just past the
          // quote, so it sits above the following word instead of covering it.
          top: last.top - origin.top + 1,
          left: last.right - origin.left - 3,
        });
      }
      rangesRef.current = ranges;
      setPins((previous) => (samePins(previous, next) ? previous : next));
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(apply);
    };
    apply();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(container);
    // Streaming or a re-render replaces text nodes; the live ranges must follow.
    const mutationObserver = new MutationObserver(schedule);
    mutationObserver.observe(source, { childList: true, characterData: true, subtree: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      clearRanges();
    };
  }, [comments, messageId]);

  // Hover from a card emphasises its quote without re-resolving every range.
  useEffect(() => {
    const active = highlightFor(THREAD_COMMENT_ACTIVE_HIGHLIGHT);
    const range = hoveredCommentId === null ? undefined : rangesRef.current.get(hoveredCommentId);
    if (!active || !range) return;
    active.add(range);
    return () => {
      active.delete(range);
    };
  }, [hoveredCommentId]);

  const openComment = (commentId: string) => {
    useThreadCommentsUiStore.getState().focusComment(commentId);
    useRightPanelStore.getState().open(threadRef, "comments");
  };

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      {pins.map((pin) => (
        <button
          key={pin.commentId}
          type="button"
          data-thread-comment-pin={pin.commentId}
          aria-label={`${THREAD_COMMENT_KIND_LABEL[pin.kind]} #${pin.number}: open in the Comments panel`}
          className={cn(
            "pointer-events-auto absolute flex size-3.5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-[9px] font-semibold leading-none tabular-nums shadow-sm ring-1 ring-background transition-transform hover:scale-125",
            PIN_KIND_CLASS[pin.kind],
          )}
          style={{ top: pin.top, left: pin.left }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseEnter={() => useThreadCommentsUiStore.getState().setHovered(pin.commentId)}
          onMouseLeave={() => useThreadCommentsUiStore.getState().setHovered(null)}
          onClick={(event) => {
            event.stopPropagation();
            openComment(pin.commentId);
          }}
        >
          {pin.number}
        </button>
      ))}
    </div>
  );
});
