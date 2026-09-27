// T3-CUSTOM(expbkt3): auto-animate for a sidebar list, with a real teardown.
//
// auto-animate keeps a MutationObserver and per-element bookkeeping alive for
// every list it is handed and releases none of it when that list unmounts. The
// phase sidebar animates several lists at once and remounts them as sections
// come and go, so without a teardown the page accumulates observers over
// detached nodes for as long as it stays open.
//
// The leak is not only wasted work. To animate a removal the library re-inserts
// the child it is animating out, choosing the destination from remembered
// siblings (`remove()` in @formkit/auto-animate), so a stale or empty animated
// list is somewhere a row can land. That list is animated in turn, so the
// arrival re-enters the same handler and the pair never settles: the row is
// re-inserted, faded, removed and re-inserted several times a second, which
// reads as a row blinking on and off until the page is reloaded.
//
// Two rules keep it closed, and both are needed. Destroy the controller when
// the node goes away — React 19 ref cleanups make that a one-liner — and never
// animate a list that renders nothing, so there is no empty list for a row to
// be re-inserted into in the first place.
import { autoAnimate } from "@formkit/auto-animate";
import type { RefCallback } from "react";

const PHASE_SIDEBAR_LIST_ANIMATION = { duration: 180, easing: "ease-out" } as const;

/**
 * Animates a list while it is mounted, and only while.
 *
 * Stateless, so it is defined once rather than per render: a ref callback with
 * a new identity every render is detached and reattached every render, which
 * would reintroduce exactly the churn this guards against.
 */
export const autoAnimatedListRef: RefCallback<HTMLElement> = (node) => {
  if (!node) return;
  const controller = autoAnimate(node, { ...PHASE_SIDEBAR_LIST_ANIMATION });
  return () => {
    // `destroy` is optional in the published types but present at runtime;
    // `disable` at least stops further animations on an older build.
    if (controller.destroy) controller.destroy();
    else controller.disable();
  };
};
