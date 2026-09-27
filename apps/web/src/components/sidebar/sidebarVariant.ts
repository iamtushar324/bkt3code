export function shouldUsePhaseGroupedSidebar(input: {
  readonly clientSettingsHydrated: boolean;
  readonly phaseGroupedSidebarEnabled: boolean;
  readonly pathname: string;
}): boolean {
  return (
    input.clientSettingsHydrated &&
    input.phaseGroupedSidebarEnabled &&
    !input.pathname.startsWith("/settings")
  );
}
