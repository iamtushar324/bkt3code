// Settings opens as a modal over the thread sidebar, so the phase-grouped
// sidebar stays in place on settings routes too.
export function shouldUsePhaseGroupedSidebar(input: {
  readonly clientSettingsHydrated: boolean;
  readonly phaseGroupedSidebarEnabled: boolean;
}): boolean {
  return input.clientSettingsHydrated && input.phaseGroupedSidebarEnabled;
}
