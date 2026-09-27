import { describe, expect, it } from "vite-plus/test";

import { resolveReviewAvailability, resolveReviewResultPresentation } from "./reviewAvailability";

describe("resolveReviewAvailability", () => {
  it("keeps section navigation available when another section is cached offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: true,
      }),
    ).toEqual({
      showConnectionNotice: true,
      showSectionToolbar: true,
    });
  });

  it("hides section navigation when no review section is available offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: false,
        hasAnyCachedDiff: false,
      }),
    ).toEqual({
      showConnectionNotice: true,
      showSectionToolbar: false,
    });
  });

  it("shows cached selected content and navigation while offline", () => {
    expect(
      resolveReviewAvailability({
        hasEnvironmentPresentation: true,
        isEnvironmentConnected: false,
        hasCachedSelectedDiff: true,
        hasAnyCachedDiff: true,
      }),
    ).toEqual({
      showConnectionNotice: false,
      showSectionToolbar: true,
    });
  });
});

describe("resolveReviewResultPresentation", () => {
  it("never treats an unavailable query as a successful empty diff", () => {
    expect(
      resolveReviewResultPresentation({
        error: "The workspace is outside the allowed root.",
        hasSelectedSection: false,
        parsedDiffKind: "empty",
      }),
    ).toEqual({ showNoSections: false, showUnavailable: true, showSuccessfulEmpty: false });
  });

  it("shows an empty state only after a successful empty result", () => {
    expect(
      resolveReviewResultPresentation({
        error: null,
        hasSelectedSection: true,
        parsedDiffKind: "empty",
      }),
    ).toEqual({ showNoSections: false, showUnavailable: false, showSuccessfulEmpty: true });
  });

  it("does not claim an empty worktree when the first request fails with no sections", () => {
    expect(
      resolveReviewResultPresentation({
        error: "Could not load review diff.",
        hasSelectedSection: false,
        parsedDiffKind: "empty",
      }),
    ).toEqual({ showNoSections: false, showUnavailable: true, showSuccessfulEmpty: false });
  });
});
