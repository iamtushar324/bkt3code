export function resolveReviewAvailability(input: {
  readonly hasEnvironmentPresentation: boolean;
  readonly isEnvironmentConnected: boolean;
  readonly hasCachedSelectedDiff: boolean;
  readonly hasAnyCachedDiff: boolean;
}): {
  readonly showConnectionNotice: boolean;
  readonly showSectionToolbar: boolean;
} {
  const showConnectionNotice =
    input.hasEnvironmentPresentation &&
    !input.isEnvironmentConnected &&
    !input.hasCachedSelectedDiff;

  return {
    showConnectionNotice,
    showSectionToolbar: !showConnectionNotice || input.hasAnyCachedDiff,
  };
}

// T3-CUSTOM(expbkt3): keep failed and successful-empty review states disjoint.
/**
 * A failed diff query says nothing about whether the worktree is clean. Keep
 * the unavailable and successful-empty states disjoint so the recovery UI
 * cannot accidentally make a success claim from a stale empty value.
 */
export function resolveReviewResultPresentation(input: {
  readonly error: string | null;
  readonly hasSelectedSection: boolean;
  readonly parsedDiffKind: "empty" | "files" | "raw";
}): {
  readonly showUnavailable: boolean;
  readonly showNoSections: boolean;
  readonly showSuccessfulEmpty: boolean;
} {
  const showUnavailable = input.error !== null;
  return {
    showUnavailable,
    showNoSections: !showUnavailable && !input.hasSelectedSection,
    showSuccessfulEmpty: !showUnavailable && input.parsedDiffKind === "empty",
  };
}
