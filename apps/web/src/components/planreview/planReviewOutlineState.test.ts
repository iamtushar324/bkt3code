import { describe, expect, it } from "vite-plus/test";

import { initialPlanReviewOutlineState, planReviewOutlineReducer } from "./planReviewOutlineState";

const open = { isOpen: true } as const;

describe("plan outline visibility", () => {
  it("starts collapsed", () => {
    expect(initialPlanReviewOutlineState.isOpen).toBe(false);
  });

  it("opens and closes on the button", () => {
    const opened = planReviewOutlineReducer(initialPlanReviewOutlineState, { type: "toggled" });
    expect(opened.isOpen).toBe(true);
    expect(planReviewOutlineReducer(opened, { type: "toggled" }).isOpen).toBe(false);
  });

  it("steps aside once a section is chosen", () => {
    expect(planReviewOutlineReducer(open, { type: "heading-selected" }).isOpen).toBe(false);
  });

  it("closes on Escape or a click outside", () => {
    expect(planReviewOutlineReducer(open, { type: "dismissed" }).isOpen).toBe(false);
  });

  it("puts itself away when it is left alone", () => {
    expect(planReviewOutlineReducer(open, { type: "idle-timeout" }).isOpen).toBe(false);
  });

  it("ignores an idle timeout that arrives after it already closed", () => {
    const closed = { isOpen: false };
    expect(planReviewOutlineReducer(closed, { type: "idle-timeout" })).toBe(closed);
  });
});
