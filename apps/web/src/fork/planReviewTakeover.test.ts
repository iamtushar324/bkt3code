import { describe, expect, it } from "vite-plus/test";

import {
  appendDismissedDocumentId,
  PLAN_REVIEW_DISMISSED_LIMIT,
  removeDismissedDocumentId,
} from "../planReviewTakeoverStore";
import { shouldShowPlanReviewTakeover } from "./planReviewTakeover";

describe("shouldShowPlanReviewTakeover", () => {
  const base = { enabled: true, documentId: "plan-doc:demo", dismissedDocumentIds: [] as string[] };

  it("opens once the review document resolves", () => {
    expect(shouldShowPlanReviewTakeover(base)).toBe(true);
  });

  it("stays out of the way while the server is still capturing the plan", () => {
    // The plan lands before its review document exists; null covers both that
    // window and "there is no plan", and neither should take the transcript.
    expect(shouldShowPlanReviewTakeover({ ...base, documentId: null })).toBe(false);
  });

  it("does not reopen a plan the user closed", () => {
    expect(shouldShowPlanReviewTakeover({ ...base, dismissedDocumentIds: ["plan-doc:demo"] })).toBe(
      false,
    );
  });

  it("still opens the next plan after an earlier one was dismissed", () => {
    expect(
      shouldShowPlanReviewTakeover({
        ...base,
        documentId: "plan-doc:next",
        dismissedDocumentIds: ["plan-doc:demo"],
      }),
    ).toBe(true);
  });

  it("stays closed when the setting is off", () => {
    expect(shouldShowPlanReviewTakeover({ ...base, enabled: false })).toBe(false);
  });
});

describe("appendDismissedDocumentId", () => {
  it("records a dismissal", () => {
    expect(appendDismissedDocumentId([], "a")).toEqual(["a"]);
  });

  it("returns the same list when the document is already dismissed", () => {
    const dismissed = ["a", "b"];
    // Identity matters: the store skips the state update on an unchanged list.
    expect(appendDismissedDocumentId(dismissed, "a")).toBe(dismissed);
  });

  it("drops the oldest dismissals past the limit", () => {
    const full = Array.from({ length: PLAN_REVIEW_DISMISSED_LIMIT }, (_, index) => `doc-${index}`);
    const next = appendDismissedDocumentId(full, "newest");

    expect(next).toHaveLength(PLAN_REVIEW_DISMISSED_LIMIT);
    expect(next.at(-1)).toBe("newest");
    expect(next).not.toContain("doc-0");
  });
});

describe("removeDismissedDocumentId", () => {
  it("brings a closed plan back", () => {
    const dismissed = removeDismissedDocumentId(["plan-doc:demo"], "plan-doc:demo");

    // The resolver is the observable half: asking for the plan again has to
    // make the takeover show, not just mutate a list.
    expect(
      shouldShowPlanReviewTakeover({
        enabled: true,
        documentId: "plan-doc:demo",
        dismissedDocumentIds: dismissed,
      }),
    ).toBe(true);
  });

  it("leaves other closed plans closed", () => {
    const dismissed = removeDismissedDocumentId(
      ["plan-doc:a", "plan-doc:b", "plan-doc:c"],
      "plan-doc:b",
    );

    expect(dismissed).toEqual(["plan-doc:a", "plan-doc:c"]);
    expect(
      shouldShowPlanReviewTakeover({
        enabled: true,
        documentId: "plan-doc:a",
        dismissedDocumentIds: dismissed,
      }),
    ).toBe(false);
  });

  it("returns the same list when the plan was never closed", () => {
    const dismissed = ["plan-doc:a"];
    // Identity matters: the store skips the state update on an unchanged list.
    expect(removeDismissedDocumentId(dismissed, "plan-doc:missing")).toBe(dismissed);
  });

  it("survives a close, reopen, close cycle", () => {
    let dismissed: ReadonlyArray<string> = [];
    dismissed = appendDismissedDocumentId(dismissed, "plan-doc:demo");
    dismissed = removeDismissedDocumentId(dismissed, "plan-doc:demo");
    dismissed = appendDismissedDocumentId(dismissed, "plan-doc:demo");

    expect(
      shouldShowPlanReviewTakeover({
        enabled: true,
        documentId: "plan-doc:demo",
        dismissedDocumentIds: dismissed,
      }),
    ).toBe(false);
  });

  it("still respects the setting when a plan is reopened", () => {
    // Reopening is not an override: the feature being off still wins.
    expect(
      shouldShowPlanReviewTakeover({
        enabled: false,
        documentId: "plan-doc:demo",
        dismissedDocumentIds: removeDismissedDocumentId(["plan-doc:demo"], "plan-doc:demo"),
      }),
    ).toBe(false);
  });
});
