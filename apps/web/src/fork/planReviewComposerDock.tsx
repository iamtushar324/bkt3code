/**
 * T3-CUSTOM(expbkt3): relocates the one live thread composer into plan review.
 *
 * The composer owns durable draft and attachment state, so plan review must not
 * render a smaller imitation or mount a second instance. React always portals
 * it into the same stable element; this module only moves that element between
 * its normal home and the plan review panel. Local composer state therefore
 * survives opening and closing a review.
 *
 * While docked, the composer rests at its short height whenever nothing in it
 * is focused (`usePlanReviewDockedRest`).
 */
import type { ComponentProps } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

// The portal container is a DOM node React never renders, so it is moved and restyled outside it.
function placePortalNode(portalNode: HTMLDivElement, destination: HTMLElement, docked: boolean) {
  portalNode.className = docked ? "block min-w-0 w-full" : "contents";
  if (docked) {
    portalNode.dataset.planReviewComposerDocked = "true";
  } else {
    delete portalNode.dataset.planReviewComposerDocked;
  }
  destination.append(portalNode);
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

    placePortalNode(portalNode, destination, target !== null);
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

export function resetPlanReviewComposerDockForTests() {
  usePlanReviewComposerDockStore.setState({
    target: null,
    scrollSurface: null,
    isFocusWithin: false,
  });
}
