import { describe, expect, it } from "vite-plus/test";

import { canHidePlanGlobalNote, shouldShowPlanGlobalNote } from "./planReviewGlobalNote";

describe("the plan review overall note", () => {
  it("rests behind its button until the reviewer opens it", () => {
    expect(shouldShowPlanGlobalNote({ isOpen: false, note: "" })).toBe(false);
    expect(shouldShowPlanGlobalNote({ isOpen: true, note: "" })).toBe(true);
  });

  it("stays visible while it holds text, however it was closed", () => {
    expect(shouldShowPlanGlobalNote({ isOpen: false, note: "Start with the migration." })).toBe(
      true,
    );
  });

  it("only offers the way out while nothing would be hidden", () => {
    expect(canHidePlanGlobalNote("")).toBe(true);
    expect(canHidePlanGlobalNote("   \n ")).toBe(true);
    expect(canHidePlanGlobalNote("Too broad.")).toBe(false);
  });
});
