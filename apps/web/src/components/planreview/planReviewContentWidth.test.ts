import { describe, expect, it } from "vite-plus/test";

import {
  canStepPlanContentWidth,
  PLAN_CONTENT_WIDTH_CLASS,
  PLAN_CONTENT_WIDTHS,
  stepPlanContentWidth,
} from "./planReviewContentWidth";

describe("plan content width", () => {
  it("adds side margin a step at a time", () => {
    expect(stepPlanContentWidth("full", 1)).toBe("wide");
    expect(stepPlanContentWidth("wide", 1)).toBe("comfortable");
    expect(stepPlanContentWidth("comfortable", 1)).toBe("narrow");
  });

  it("takes it back the same way", () => {
    expect(stepPlanContentWidth("narrow", -1)).toBe("comfortable");
    expect(stepPlanContentWidth("wide", -1)).toBe("full");
  });

  it("sticks at both ends rather than wrapping around", () => {
    // Wrapping from narrow straight back to full width would be a trap: the
    // button that was narrowing the plan would suddenly widen it.
    expect(stepPlanContentWidth("narrow", 1)).toBe("narrow");
    expect(stepPlanContentWidth("full", -1)).toBe("full");
    expect(canStepPlanContentWidth("narrow", 1)).toBe(false);
    expect(canStepPlanContentWidth("full", -1)).toBe(false);
    expect(canStepPlanContentWidth("full", 1)).toBe(true);
  });

  it("has a class for every step", () => {
    for (const width of PLAN_CONTENT_WIDTHS) {
      expect(PLAN_CONTENT_WIDTH_CLASS[width]).toMatch(/^max-w-/);
    }
  });
});
