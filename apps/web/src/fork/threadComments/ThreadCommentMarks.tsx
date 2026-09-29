/**
 * T3-CUSTOM(expbkt3): highlights, pins and gutter markers for the comments on
 * one assistant message.
 *
 * Rendered as a sibling right after upstream's `AssistantCitationSource` in the
 * timeline row, whose outer element is already `position: relative`. Each
 * comment's quote is re-resolved against the rendered text with upstream's
 * citation anchoring and painted through a CSS custom highlight, with a small
 * numbered pin at the end of the range as the click target (highlights are not
 * hit-testable). To be findable while scrolling, every unresolved comment also
 * draws a bar in the row's left gutter spanning its lines, and the message
 * carries one bubble chip with the unresolved count at its top-right corner
 * (the timeline clips anything outside the message column, so a chip cannot
 * hang in the margin). Everything is absolutely positioned inside the row, so
 * it travels with the virtualised list for free, and is only recomputed when
 * the row resizes or its text mutates — never on scroll or per frame.
 */
import type { ScopedThreadRef, ThreadComment } from "@t3tools/contracts";
import { MessageSquareTextIcon } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { resolveAssistantCitationRange } from "../../lib/assistantTextSelection";
import { useRightPanelStore } from "../../rightPanelStore";
import { highlightFor, removeRangeFromHighlights } from "./highlights";
import { useThreadCommentsEnabled, useThreadCommentsSnapshot } from "./hooks";
import {
  commentsForMessage,
  highlightNameForComment,
  messageMarkerState,
  mostUrgentComment,
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

/** One gutter bar per unresolved comment, spanning the lines its quote covers. */
interface GutterBar {
  readonly commentId: string;
  readonly status: "open" | "addressed";
  readonly top: number;
  readonly height: number;
}

const PIN_KIND_CLASS: Record<ThreadComment["kind"], string> = {
  comment: "bg-warning text-black/80",
  good: "bg-success text-white",
  okay: "bg-muted-foreground text-background",
  remove: "bg-destructive text-white",
};

const URGENCY_CLASS = {
  open: "bg-warning text-black/80",
  addressed: "bg-info text-white",
} as const;

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

function sameBars(left: ReadonlyArray<GutterBar>, right: ReadonlyArray<GutterBar>): boolean {
  if (left.length !== right.length) return false;
  return left.every((bar, index) => {
    const other = right[index]!;
    return (
      bar.commentId === other.commentId &&
      bar.status === other.status &&
      Math.abs(bar.top - other.top) < 0.5 &&
      Math.abs(bar.height - other.height) < 0.5
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
  const [bars, setBars] = useState<ReadonlyArray<GutterBar>>([]);
  const rangesRef = useRef<ReadonlyMap<string, Range>>(new Map());
  const hoveredCommentId = useThreadCommentsUiStore((state) => state.hoveredCommentId);
  const marker = useMemo(() => messageMarkerState(comments), [comments]);

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
      const nextPins: Pin[] = [];
      const nextBars: GutterBar[] = [];
      for (const comment of comments) {
        const range = resolveAssistantCitationRange(source, comment.anchor);
        if (!range) continue;
        ranges.set(comment.commentId, range);
        const name = highlightNameForComment(comment);
        if (name) highlightFor(name)?.add(range);
        if (activeId === comment.commentId) {
          highlightFor(THREAD_COMMENT_ACTIVE_HIGHLIGHT)?.add(range);
        }
        // Resolved comments keep a faint highlight but no pin or bar: those are calls to act.
        if (comment.status === "resolved") continue;
        const rects = range.getClientRects();
        const last = rects.item(rects.length - 1);
        if (!last) continue;
        let top = Number.POSITIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;
        for (const rect of rects) {
          if (rect.height <= 0) continue;
          top = Math.min(top, rect.top);
          bottom = Math.max(bottom, rect.bottom);
        }
        if (Number.isFinite(top) && bottom > top) {
          nextBars.push({
            commentId: comment.commentId,
            status: comment.status,
            top: top - origin.top,
            height: bottom - top,
          });
        }
        nextPins.push({
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
      setPins((previous) => (samePins(previous, nextPins) ? previous : nextPins));
      setBars((previous) => (sameBars(previous, nextBars) ? previous : nextBars));
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
  const setHovered = (commentId: string | null) =>
    useThreadCommentsUiStore.getState().setHovered(commentId);
  const urgent = marker === null ? null : mostUrgentComment(comments);

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      {bars.map((bar) => (
        // The row's 4px horizontal padding is the gutter; a 3px bar fits beside the text.
        <button
          key={`bar:${bar.commentId}`}
          type="button"
          data-thread-comment-bar={bar.commentId}
          aria-label={`Commented lines: open comment in the Comments panel`}
          className={cn(
            "pointer-events-auto absolute left-0 w-[3px] cursor-pointer rounded-full transition-opacity hover:opacity-100",
            bar.status === "open" ? "bg-warning opacity-90" : "bg-info opacity-80",
          )}
          style={{ top: bar.top, height: bar.height }}
          onPointerDown={(event) => event.preventDefault()}
          onMouseEnter={() => setHovered(bar.commentId)}
          onMouseLeave={() => setHovered(null)}
          onClick={(event) => {
            event.stopPropagation();
            openComment(bar.commentId);
          }}
        />
      ))}
      {marker !== null && urgent !== null ? (
        <button
          type="button"
          data-thread-comment-marker={messageId}
          aria-label={`${marker.count} ${marker.count === 1 ? "comment" : "comments"} to handle on this message: open in the Comments panel`}
          className={cn(
            "pointer-events-auto absolute top-0.5 right-1 flex h-4 cursor-pointer items-center gap-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums shadow-sm ring-1 ring-background transition-transform hover:scale-110",
            URGENCY_CLASS[marker.urgency],
          )}
          onPointerDown={(event) => event.preventDefault()}
          onMouseEnter={() => setHovered(urgent.commentId)}
          onMouseLeave={() => setHovered(null)}
          onClick={(event) => {
            event.stopPropagation();
            openComment(urgent.commentId);
          }}
        >
          <MessageSquareTextIcon className="size-2.5" aria-hidden />
          {marker.count}
        </button>
      ) : null}
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
          onMouseEnter={() => setHovered(pin.commentId)}
          onMouseLeave={() => setHovered(null)}
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
