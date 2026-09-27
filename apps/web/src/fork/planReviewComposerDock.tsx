/**
 * T3-CUSTOM(expbkt3): relocates the one live thread composer into plan review.
 *
 * The composer owns durable draft and attachment state, so plan review must not
 * render a smaller imitation or mount a second instance. React always portals
 * it into the same stable element; this module only moves that element between
 * its normal home and the plan review panel. Local composer state therefore
 * survives opening and closing a review.
 *
 * While docked, the composer also rests the way it does in chat: upstream's
 * wheel gesture collapses it, and the plan document — not the hidden timeline —
 * is the surface that gesture watches. Nothing here re-implements the gesture;
 * it only answers the three questions `ChatComposer` already asks about its
 * scroll surface with the docked document instead.
 */
import type { ComponentProps } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";

import { ComposerSurface } from "../components/chat/ComposerSurface";

interface PlanReviewComposerDockState {
  readonly target: HTMLElement | null;
  readonly scrollSurface: HTMLElement | null;
  readonly isFocusWithin: boolean;
  readonly setTarget: (target: HTMLElement | null) => void;
  readonly setScrollSurface: (surface: HTMLElement | null) => void;
  readonly setFocusWithin: (isFocusWithin: boolean) => void;
}

const usePlanReviewComposerDockStore = create<PlanReviewComposerDockState>((set) => ({
  target: null,
  scrollSurface: null,
  isFocusWithin: false,
  setTarget: (target) => set({ target }),
  setScrollSurface: (scrollSurface) => set({ scrollSurface }),
  setFocusWithin: (isFocusWithin) => set({ isFocusWithin }),
}));

/** The destination rendered across the bottom of the plan review panel. */
export function PlanReviewConversationComposerTarget() {
  const setTarget = usePlanReviewComposerDockStore((state) => state.setTarget);
  const targetRef = useCallback(
    (node: HTMLDivElement | null) => {
      setTarget(node);
    },
    [setTarget],
  );

  return (
    // `shrink-0` so the panel above gives up the space when the composer grows,
    // rather than the composer being squeezed into a clipped row.
    <div
      className="min-w-0 shrink-0 border-t bg-background px-2 pt-1.5 pb-2"
      data-plan-review-conversation-composer
    >
      <div ref={targetRef} className="min-w-0" data-plan-review-composer-target />
    </div>
  );
}

/**
 * Mark the element the docked composer treats as its scroll surface.
 *
 * The plan document column is what the reviewer scrolls while reading, so it
 * plays the part the message timeline plays in chat.
 */
export function usePlanReviewScrollSurfaceRef() {
  const setScrollSurface = usePlanReviewComposerDockStore((state) => state.setScrollSurface);
  return useCallback(
    (node: HTMLElement | null) => {
      setScrollSurface(node);
    },
    [setScrollSurface],
  );
}

/** Keep one mounted composer while its portal container moves between homes. */
export function PlanReviewComposerDock(props: ComponentProps<typeof ComposerSurface.Shell>) {
  const target = usePlanReviewComposerDockStore((state) => state.target);
  const setFocusWithin = usePlanReviewComposerDockStore((state) => state.setFocusWithin);
  const homeRef = useRef<HTMLDivElement | null>(null);
  const [portalNode] = useState(() => document.createElement("div"));

  useLayoutEffect(() => {
    const destination = target ?? homeRef.current;
    if (destination === null) return;

    portalNode.className = target === null ? "contents" : "block min-w-0 w-full";
    if (target === null) {
      delete portalNode.dataset.planReviewComposerDocked;
    } else {
      portalNode.dataset.planReviewComposerDocked = "true";
    }
    destination.append(portalNode);
  }, [portalNode, target]);

  // Focus is tracked on the portal element rather than through the composer's
  // own focus state: that state never clears on desktop blur, and this module
  // needs to know when the reviewer has actually left the bar.
  useEffect(() => {
    if (target === null) {
      setFocusWithin(false);
      return;
    }
    let frame: number | null = null;
    const cancel = () => {
      if (frame === null) return;
      window.cancelAnimationFrame(frame);
      frame = null;
    };
    const onFocusIn = () => {
      cancel();
      setFocusWithin(true);
    };
    // Focus leaves and re-enters within one frame while moving between the
    // editor and the send button, so the answer is read after that settles.
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && portalNode.contains(next)) return;
      cancel();
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const active = document.activeElement;
        setFocusWithin(active instanceof Node && portalNode.contains(active));
      });
    };
    portalNode.addEventListener("focusin", onFocusIn);
    portalNode.addEventListener("focusout", onFocusOut);
    return () => {
      cancel();
      portalNode.removeEventListener("focusin", onFocusIn);
      portalNode.removeEventListener("focusout", onFocusOut);
      setFocusWithin(false);
    };
  }, [portalNode, setFocusWithin, target]);

  useLayoutEffect(
    () => () => {
      portalNode.remove();
    },
    [portalNode],
  );

  return (
    <>
      <div ref={homeRef} className="contents" data-plan-review-composer-home />
      {createPortal(<ComposerSurface.Shell {...props} />, portalNode)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Resting while docked
// ---------------------------------------------------------------------------

/**
 * Whether the composer's plan follow-up banner should be shown.
 *
 * Outside plan review it is the only thing telling the reviewer a plan is
 * waiting, so it stays. Inside plan review the plan *is* the surface, the rail
 * already carries Approve and Send feedback — and the banner is chrome, which
 * upstream (correctly) treats as a reason to hold the composer open. Left in,
 * it pins the docked bar at full height in the one state it is ever used in.
 */
export function shouldShowPlanFollowUpDrawer(input: {
  readonly isDockedInPlanReview: boolean;
  readonly showPlanFollowUpPrompt: boolean;
  readonly hasActiveProposedPlan: boolean;
  readonly isCollapsedMobile: boolean;
}): boolean {
  if (input.isDockedInPlanReview) return false;
  return !input.isCollapsedMobile && input.showPlanFollowUpPrompt && input.hasActiveProposedPlan;
}

/** Whether the one live composer is currently docked into plan review. */
export function usePlanReviewComposerDocked(): boolean {
  return usePlanReviewComposerDockStore((state) => state.target !== null);
}

/**
 * Whether a docked composer should be resting.
 *
 * Blur is the one rule here that chat does not have: chat keeps the composer
 * open when focus moves to a message, because there the composer is the page's
 * main input. Docked under a plan it is a side channel, and every pixel it
 * holds is a line of the plan the reviewer cannot see.
 */
export function shouldRestDockedComposer(input: {
  readonly isDocked: boolean;
  readonly isFocusWithin: boolean;
  readonly hasMultilinePrompt: boolean;
  readonly hasExpandedChrome: boolean;
}): boolean {
  return (
    input.isDocked && !input.isFocusWithin && !input.hasMultilinePrompt && !input.hasExpandedChrome
  );
}

/**
 * Hold a docked composer at its resting height whenever nothing in it is
 * focused, including the frame it docks in — so a review opens with the bar
 * already short instead of expanding and then collapsing.
 *
 * Reading the current collapse flag makes this self-correcting: anything that
 * expands the composer while the reviewer is elsewhere is undone on the next
 * render rather than leaving the bar tall until the next gesture.
 */
export function usePlanReviewDockedRest(input: {
  readonly isComposerScrollCollapsed: boolean;
  readonly setIsComposerScrollCollapsed: (collapsed: boolean) => void;
  readonly hasMultilinePrompt: boolean;
  readonly hasExpandedChrome: boolean;
}): void {
  const isDocked = usePlanReviewComposerDockStore((state) => state.target !== null);
  const isFocusWithin = usePlanReviewComposerDockStore((state) => state.isFocusWithin);
  const shouldRest = shouldRestDockedComposer({
    isDocked,
    isFocusWithin,
    hasMultilinePrompt: input.hasMultilinePrompt,
    hasExpandedChrome: input.hasExpandedChrome,
  });
  const { isComposerScrollCollapsed, setIsComposerScrollCollapsed } = input;

  useEffect(() => {
    if (!shouldRest || isComposerScrollCollapsed) return;
    setIsComposerScrollCollapsed(true);
  }, [isComposerScrollCollapsed, setIsComposerScrollCollapsed, shouldRest]);
}

// ---------------------------------------------------------------------------
// Scroll surface
// ---------------------------------------------------------------------------

const SCROLLABLE_RESOLUTION_TTL_MS = 500;

const resolvedScrollables = new WeakMap<HTMLElement, { node: HTMLElement | null; at: number }>();

function isScrollableNode(node: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(node).overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll") return false;
  return node.scrollHeight > node.clientHeight + 1;
}

/**
 * The element that actually scrolls inside the marked surface.
 *
 * The panel marks its document column, but the scroller is whichever descendant
 * the current view mounts — the editor, the rendered HTML plan, or the version
 * list. Resolution is cached because this runs inside a wheel handler; a miss is
 * cached too, so a plan short enough to have no scroller is not rescanned on
 * every event.
 */
function resolveScrollableNode(surface: HTMLElement): HTMLElement | null {
  const now = window.performance.now();
  const cached = resolvedScrollables.get(surface);
  if (cached && now - cached.at < SCROLLABLE_RESOLUTION_TTL_MS) {
    if (cached.node === null) return null;
    if (surface.contains(cached.node) && isScrollableNode(cached.node)) return cached.node;
  }

  let found: HTMLElement | null = isScrollableNode(surface) ? surface : null;
  if (found === null) {
    for (const node of surface.querySelectorAll<HTMLElement>("*")) {
      if (isScrollableNode(node)) {
        found = node;
        break;
      }
    }
  }
  resolvedScrollables.set(surface, { node: found, at: now });
  return found;
}

/**
 * The three questions `ChatComposer` asks about its scroll surface, named as it
 * names them so the call site stays a single spread.
 */
export interface ComposerScrollSurface {
  readonly getTimelineScrollableNode: () => HTMLElement | null;
  readonly isTimelineAtLogicalEnd: () => boolean;
  readonly timelineOverflows: boolean;
}

/**
 * Answer the composer's scroll-surface questions from the plan document while
 * docked, and pass chat's own answers through the rest of the time.
 *
 * `overflows` is true whenever docked: upstream asks it to avoid resting a
 * composer that has no reading space to give back, and in the plan panel the
 * bar always does — every pixel it releases is plan.
 */
export function usePlanReviewComposerScrollSurface({
  getTimelineScrollableNode,
  isTimelineAtLogicalEnd,
  timelineOverflows,
}: ComposerScrollSurface) {
  const scrollSurface = usePlanReviewComposerDockStore((state) => state.scrollSurface);
  const isDocked = usePlanReviewComposerDockStore((state) => state.target !== null);
  const docked = isDocked && scrollSurface !== null;

  return useMemo<ComposerScrollSurface>(
    () => ({
      getTimelineScrollableNode: () =>
        docked && scrollSurface !== null
          ? resolveScrollableNode(scrollSurface)
          : getTimelineScrollableNode(),
      isTimelineAtLogicalEnd: () => {
        if (!docked || scrollSurface === null) return isTimelineAtLogicalEnd();
        const node = resolveScrollableNode(scrollSurface);
        if (node === null) return true;
        return node.scrollTop >= node.scrollHeight - node.clientHeight - 2;
      },
      timelineOverflows: docked ? true : timelineOverflows,
    }),
    [docked, getTimelineScrollableNode, isTimelineAtLogicalEnd, scrollSurface, timelineOverflows],
  );
}

export function resetPlanReviewComposerDockForTests() {
  usePlanReviewComposerDockStore.setState({
    target: null,
    scrollSurface: null,
    isFocusWithin: false,
  });
}
