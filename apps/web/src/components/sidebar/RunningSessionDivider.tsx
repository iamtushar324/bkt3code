/** A deliberately quiet boundary before work the user is monitoring. */
export function RunningSessionDivider() {
  return (
    <div
      role="separator"
      aria-label="Monitoring agent work"
      className="mb-2 flex items-center gap-2 px-2 pt-0.5"
      data-testid="phase-sidebar-running-divider"
    >
      <span className="h-px flex-1 bg-sidebar-border/45" />
      <span className="text-[8px] font-medium uppercase tracking-[0.14em] text-muted-foreground/35">
        Monitoring
      </span>
      <span className="h-px flex-1 bg-sidebar-border/45" />
    </div>
  );
}
