/**
 * T3-CUSTOM(expbkt3): the plan's heading structure, with comment counts.
 *
 * A plan long enough to need reviewing is longer than the panel, and the rail of
 * comments alone does not say *where* in the plan the argument is. The counts are
 * the useful half: they show at a glance which sections the reviewer has already
 * been through and which they have not touched.
 *
 * It used to hold a 14rem column open for the whole review, which is the wrong
 * trade in a panel where the document is the scarce thing — and it vanished
 * entirely below ~56rem, the width where it mattered most. Now it collapses to
 * one icon in a 1.75rem gutter, opens on a click as an overlay so the document
 * never reflows, and closes itself again once it has been used or left alone.
 * See `planReviewOutlineState` for the rules; the timings live here.
 */
import { ListIcon } from "lucide-react";
import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { PlanOutlineHeading } from "@t3tools/client-runtime/state/planReviewMarkdown";
import { cn } from "../../lib/utils";
import { initialPlanReviewOutlineState, planReviewOutlineReducer } from "./planReviewOutlineState";

/** Indent per heading level, capped so a deep plan does not run out of column. */
const DEPTH_INDENT_CLASS = ["ps-2", "ps-2", "ps-4", "ps-6", "ps-8", "ps-8", "ps-8"] as const;

/** How long an untouched open outline waits before putting itself away. */
const IDLE_CLOSE_MS = 12_000;

function PlanReviewOutlineImpl({
  headings,
  commentCounts,
  onSelectHeading,
}: {
  readonly headings: ReadonlyArray<PlanOutlineHeading>;
  /** Open-comment counts keyed by heading line index. */
  readonly commentCounts: ReadonlyMap<number, number>;
  readonly onSelectHeading: (heading: PlanOutlineHeading) => void;
}) {
  const [state, dispatch] = useReducer(planReviewOutlineReducer, initialPlanReviewOutlineState);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restarting the countdown must not re-render: this runs on every pointer
  // move across the panel, and the list underneath it is pure chrome.
  const restartIdleClose = useCallback(() => {
    if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => dispatch({ type: "idle-timeout" }), IDLE_CLOSE_MS);
  }, []);

  useEffect(() => {
    if (!state.isOpen) return;
    restartIdleClose();
    return () => {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    };
  }, [restartIdleClose, state.isOpen]);

  useEffect(() => {
    if (!state.isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The plan review takeover also answers Escape, and closing the outline
      // is the smaller, more specific action, so it stops here.
      event.stopPropagation();
      dispatch({ type: "dismissed" });
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      dispatch({ type: "dismissed" });
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [panel, state.isOpen]);

  if (headings.length === 0) return null;

  let openComments = 0;
  for (const count of commentCounts.values()) openComments += count;

  return (
    <>
      {/*
        The gutter exists so the trigger never covers the plan: the document
        column reserves exactly this width, and nothing moves when the panel
        opens over the text.
      */}
      <div className="absolute inset-y-0 start-0 z-20 w-7">
        <button
          ref={triggerRef}
          type="button"
          aria-label="Plan contents"
          aria-expanded={state.isOpen}
          onClick={() => dispatch({ type: "toggled" })}
          className={cn(
            "relative mt-2 ms-1 flex size-6 items-center justify-center rounded-md border border-transparent text-muted-foreground/60 transition-colors",
            "hover:border-border hover:bg-accent hover:text-foreground focus-visible:border-border focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none",
            state.isOpen && "border-border bg-accent text-foreground",
          )}
        >
          <ListIcon className="size-3.5" aria-hidden />
          {openComments > 0 ? (
            <span
              className="-top-1 -end-1 absolute min-w-3.5 rounded-full bg-amber-400 px-1 text-[9px] text-amber-950 leading-3.5 tabular-nums"
              aria-label={`${openComments} open ${openComments === 1 ? "comment" : "comments"}`}
            >
              {openComments}
            </span>
          ) : null}
        </button>
      </div>

      {state.isOpen ? (
        <nav
          ref={setPanel}
          className="absolute top-2 start-2 z-30 flex max-h-[calc(100%-1rem)] w-52 flex-col overflow-hidden rounded-lg border bg-popover shadow-lg"
          aria-label="Plan contents"
          onPointerMove={restartIdleClose}
          onScrollCapture={restartIdleClose}
        >
          <p className="border-b px-2 py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
            Contents
          </p>
          <ul className="flex min-h-0 min-w-0 flex-col overflow-y-auto py-1">
            {headings.map((heading) => {
              const count = commentCounts.get(heading.lineIndex) ?? 0;
              return (
                <li key={`${heading.lineIndex}:${heading.text}`} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => {
                      dispatch({ type: "heading-selected" });
                      onSelectHeading(heading);
                    }}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-1.5 py-0.5 pe-2 text-left text-[11.5px] transition-colors hover:bg-accent",
                      DEPTH_INDENT_CLASS[heading.depth] ?? "ps-8",
                      heading.depth <= 1 ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate" aria-label={heading.text}>
                      {heading.text}
                    </span>
                    {count > 0 ? (
                      <span
                        className="shrink-0 rounded-full bg-amber-400/20 px-1.5 text-[10px] text-amber-700 tabular-nums dark:text-amber-300"
                        aria-label={`${count} open ${count === 1 ? "comment" : "comments"}`}
                      >
                        {count}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </>
  );
}

export const PlanReviewOutline = memo(PlanReviewOutlineImpl);
