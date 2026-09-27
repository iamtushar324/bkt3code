/**
 * T3-CUSTOM(expbkt3): when the plan outline is open, and when it closes itself.
 *
 * The rule the reviewer asked for is "never open unless I ask for it": the
 * outline opens on a click, not on approach, and it does not stay open for the
 * rest of the review — picking a section, pressing Escape, clicking away, or
 * simply leaving it alone all put it back. Keeping that as a reducer means the
 * timings in the component are the only thing left to get wrong.
 */
export interface PlanReviewOutlineState {
  readonly isOpen: boolean;
}

export type PlanReviewOutlineEvent =
  /** The gutter button was clicked. */
  | { readonly type: "toggled" }
  | { readonly type: "heading-selected" }
  /** Escape, or a click outside the panel. */
  | { readonly type: "dismissed" }
  /** Open and untouched for long enough. */
  | { readonly type: "idle-timeout" };

export const initialPlanReviewOutlineState: PlanReviewOutlineState = { isOpen: false };

const CLOSED: PlanReviewOutlineState = { isOpen: false };
const OPEN: PlanReviewOutlineState = { isOpen: true };

export function planReviewOutlineReducer(
  state: PlanReviewOutlineState,
  event: PlanReviewOutlineEvent,
): PlanReviewOutlineState {
  switch (event.type) {
    case "toggled":
      return state.isOpen ? CLOSED : OPEN;
    // Jumping to a section is the outline's whole job, so it steps aside after.
    case "heading-selected":
    case "dismissed":
      return CLOSED;
    case "idle-timeout":
      return state.isOpen ? CLOSED : state;
  }
}
