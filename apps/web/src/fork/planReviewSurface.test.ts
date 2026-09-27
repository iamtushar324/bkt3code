import { describe, expect, it } from "vite-plus/test";

import { resolveOpenPlanReviewDocumentId } from "./planReviewSurface";

describe("resolveOpenPlanReviewDocumentId", () => {
  const openDocument = [{ documentId: "plan-doc:demo", status: "open" }];

  it("returns the open review document while the plan is active", () => {
    expect(resolveOpenPlanReviewDocumentId(openDocument, "plan:demo")).toBe("plan-doc:demo");
  });

  it("hides the review entry point after the plan is no longer active", () => {
    expect(resolveOpenPlanReviewDocumentId(openDocument, null)).toBeNull();
  });
});
