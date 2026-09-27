// T3-CUSTOM(expbkt3): fork-owned coverage for plan-review line selection.
import { describe, expect, it } from "@effect/vitest";

import {
  formatPlanReviewSelectionLabel,
  togglePlanReviewLine,
  type PlanReviewSelection,
} from "./planReviewSelection";

const LINES = ["# Auth rewrite", "", "1. Add the migration", "2. Backfill the rows"];
const quoteFor = (startIndex: number, endIndex: number) =>
  LINES.slice(startIndex, endIndex + 1).join("\n");

const toggle = (current: PlanReviewSelection | null, lineIndex: number) =>
  togglePlanReviewLine({ current, documentId: "doc-1", lineIndex, quoteFor });

describe("togglePlanReviewLine", () => {
  it("anchors on the first tap", () => {
    expect(toggle(null, 2)).toEqual({
      documentId: "doc-1",
      startIndex: 2,
      endIndex: 2,
      quotedText: "1. Add the migration",
    });
  });

  it("extends downward on a second tap", () => {
    const selection = toggle(toggle(null, 2), 3);
    expect(selection).toMatchObject({ startIndex: 2, endIndex: 3 });
    expect(selection?.quotedText).toBe("1. Add the migration\n2. Backfill the rows");
  });

  it("extends upward when the second tap is above the anchor", () => {
    const selection = toggle(toggle(null, 3), 0);
    expect(selection).toMatchObject({ startIndex: 0, endIndex: 3 });
  });

  it("clears when the single selected line is tapped again", () => {
    expect(toggle(toggle(null, 2), 2)).toBeNull();
  });

  it("collapses onto a line tapped inside a multi-line selection", () => {
    const range = toggle(toggle(null, 0), 3);
    const collapsed = toggle(range, 2);
    expect(collapsed).toMatchObject({ startIndex: 2, endIndex: 2 });
  });

  it("restarts rather than extending across documents", () => {
    const other = togglePlanReviewLine({
      current: toggle(null, 0),
      documentId: "doc-2",
      lineIndex: 3,
      quoteFor,
    });
    expect(other).toMatchObject({ documentId: "doc-2", startIndex: 3, endIndex: 3 });
  });
});

describe("formatPlanReviewSelectionLabel", () => {
  it("names a single line in 1-based terms", () => {
    expect(formatPlanReviewSelectionLabel(toggle(null, 2)!)).toBe("Line 3");
  });

  it("names a range in 1-based terms", () => {
    expect(formatPlanReviewSelectionLabel(toggle(toggle(null, 2), 3)!)).toBe("Lines 3-4");
  });
});
