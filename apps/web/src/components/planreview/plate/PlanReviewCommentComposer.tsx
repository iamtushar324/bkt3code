/**
 * T3-CUSTOM(expbkt3): the comment composer, docked under the plan.
 *
 * This was briefly a popover anchored to the selection. That was wrong twice
 * over: it lived *inside* the scrolling document, so autofocusing it scrolled
 * the plan — from the bottom of a long plan, back to the top — and the box was
 * too small to write a real review comment in.
 *
 * Docking it below the document fixes both by construction. It is a sibling of
 * the scroll container rather than a child, so focusing it cannot move the plan,
 * and it has the full width of the column to grow into.
 *
 * It grows with what is typed, up to `MAX_HEIGHT_VH` of the viewport — long
 * enough to read a paragraph back before sending it, bounded so the composer can
 * never swallow the plan it is about.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

import { Button } from "../../ui/button";

/** Enough for ~5 lines, so the box reads as somewhere to write prose. */
const MIN_HEIGHT_REM = 6;
const MAX_HEIGHT_VH = 30;

const IS_APPLE = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function PlanReviewCommentComposer({
  quotedText,
  body,
  onBodyChange,
  onSubmit,
  onCancel,
}: {
  readonly quotedText: string;
  readonly body: string;
  readonly onBodyChange: (body: string) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // `preventScroll` because the plan is a scroll container and the reviewer is
    // usually reading some way down it. Belt and braces alongside docking: even
    // a stray ancestor scroll would undo the thing this component exists to fix.
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  // Grow to fit the text, then stop. Measured rather than done with CSS
  // `field-sizing`, which Safari and Firefox still do not support.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    input.style.height = "auto";
    const maxHeight = (window.innerHeight * MAX_HEIGHT_VH) / 100;
    input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  }, [body]);

  const canSubmit = body.trim().length > 0;

  return (
    <div className="shrink-0 border-t bg-card">
      <div className="flex items-start gap-2 px-3 pt-2">
        <blockquote
          className="min-w-0 flex-1 border-amber-400/60 border-l-2 pl-2 text-muted-foreground text-xs italic"
          aria-label={quotedText}
        >
          <span className="line-clamp-2 whitespace-pre-wrap wrap-break-word">{quotedText}</span>
        </blockquote>
        <button
          type="button"
          aria-label="Cancel comment"
          className="shrink-0 rounded px-1 text-muted-foreground text-xs transition-colors hover:bg-accent hover:text-foreground"
          onClick={onCancel}
        >
          ✕
        </button>
      </div>

      <div className="px-3 pt-2">
        <textarea
          ref={inputRef}
          className="w-full resize-none overflow-y-auto rounded-md border bg-background p-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={{ minHeight: `${MIN_HEIGHT_REM}rem`, maxHeight: `${MAX_HEIGHT_VH}vh` }}
          value={body}
          placeholder="What should change here?"
          aria-label="Comment body"
          onChange={(event) => onBodyChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (canSubmit) onSubmit();
            }
          }}
        />
      </div>

      <div className="flex items-center justify-end gap-2 px-3 py-2">
        <span aria-hidden className="mr-auto text-[11px] text-muted-foreground">
          {IS_APPLE ? "⌘" : "Ctrl"}+Enter to comment · Esc to cancel
        </span>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onSubmit} disabled={!canSubmit}>
          Comment
        </Button>
      </div>
    </div>
  );
}
