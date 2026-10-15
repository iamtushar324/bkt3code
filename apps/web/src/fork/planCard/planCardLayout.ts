/**
 * T3-CUSTOM(expbkt3): where a wide plan card sits.
 *
 * A wide card leaves the chat column and grows into the free width of the
 * conversation area, stopping before anything floating on the right (the
 * workspace card, a docked preview). All values are viewport pixels.
 */

/** Wide plans stop here, so lines stay readable on very large screens. */
export const PLAN_CARD_WIDE_MAX_WIDTH = 1280;

export interface WidePlanBox {
  /** Offset from the chat column's left edge (zero or negative). */
  readonly offset: number;
  readonly width: number;
}

export function resolveWidePlanBox(input: {
  /** The chat column the card normally fills. */
  readonly lane: { readonly left: number; readonly right: number };
  /** The scrolling conversation area, scrollbar excluded. */
  readonly area: { readonly left: number; readonly right: number };
  /** The conversation's side padding. */
  readonly padding: number;
  /** Left edges of floating things the card must not slide under. */
  readonly obstacles?: ReadonlyArray<number>;
  readonly maxWidth?: number;
}): WidePlanBox | null {
  const { lane, area, padding } = input;
  const laneWidth = lane.right - lane.left;
  const bandLeft = Math.min(lane.left, area.left + padding);
  // Floating things keep the same gap from the card as the area's edge does.
  const blockers = (input.obstacles ?? [])
    .filter((left) => left >= lane.right)
    .map((left) => left - padding);
  const bandRight = Math.max(lane.right, Math.min(area.right - padding, ...blockers));
  const width = Math.min(bandRight - bandLeft, input.maxWidth ?? PLAN_CARD_WIDE_MAX_WIDTH);
  // Less than a few pixels more than the column is not worth a different layout.
  if (width - laneWidth < 8) return null;
  // Grow evenly around the column, then slide back inside the free band.
  const centered = lane.left - (width - laneWidth) / 2;
  const left = Math.min(Math.max(centered, bandLeft), bandRight - width);
  return { offset: Math.round(left - lane.left), width: Math.round(width) };
}
