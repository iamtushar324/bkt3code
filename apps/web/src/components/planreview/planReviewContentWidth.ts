/**
 * T3-CUSTOM(expbkt3): how wide the plan itself is allowed to run.
 *
 * On a wide monitor the review panel gives the document more width than prose
 * wants — a table stays readable, a paragraph does not — so the reviewer gets
 * two buttons that add or remove side margin. The choice is theirs and it is
 * remembered; nothing here guesses from the viewport.
 */
import { useCallback, useState } from "react";

export const PLAN_CONTENT_WIDTHS = ["full", "wide", "comfortable", "narrow"] as const;

export type PlanContentWidth = (typeof PLAN_CONTENT_WIDTHS)[number];

/** Applied to the document with `mx-auto`, so margin grows on both sides. */
export const PLAN_CONTENT_WIDTH_CLASS: Record<PlanContentWidth, string> = {
  full: "max-w-none",
  wide: "max-w-6xl",
  comfortable: "max-w-4xl",
  narrow: "max-w-2xl",
};

export const PLAN_CONTENT_WIDTH_LABEL: Record<PlanContentWidth, string> = {
  full: "Full width",
  wide: "Wide",
  comfortable: "Comfortable",
  narrow: "Narrow",
};

const STORAGE_KEY = "t3:plan-review:content-width";
const DEFAULT_WIDTH: PlanContentWidth = "full";

function isPlanContentWidth(value: unknown): value is PlanContentWidth {
  return PLAN_CONTENT_WIDTHS.includes(value as PlanContentWidth);
}

/**
 * One step of side margin. `+1` narrows the text (more padding), `-1` widens it.
 * Both ends are sticky rather than wrapping: a button that jumps from narrow
 * back to full width would be a trap.
 */
export function stepPlanContentWidth(
  current: PlanContentWidth,
  direction: 1 | -1,
): PlanContentWidth {
  const index = PLAN_CONTENT_WIDTHS.indexOf(current);
  const next = Math.min(PLAN_CONTENT_WIDTHS.length - 1, Math.max(0, index + direction));
  return PLAN_CONTENT_WIDTHS[next] ?? current;
}

export function canStepPlanContentWidth(current: PlanContentWidth, direction: 1 | -1): boolean {
  return stepPlanContentWidth(current, direction) !== current;
}

export function readStoredPlanContentWidth(): PlanContentWidth {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isPlanContentWidth(stored) ? stored : DEFAULT_WIDTH;
  } catch {
    // Private mode, or storage disabled. The preference is a nicety.
    return DEFAULT_WIDTH;
  }
}

export function usePlanContentWidth(): readonly [PlanContentWidth, (direction: 1 | -1) => void] {
  const [width, setWidth] = useState<PlanContentWidth>(readStoredPlanContentWidth);

  const step = useCallback((direction: 1 | -1) => {
    setWidth((current) => {
      const next = stepPlanContentWidth(current, direction);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Not worth failing the click over.
      }
      return next;
    });
  }, []);

  return [width, step] as const;
}
