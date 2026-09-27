// T3-CUSTOM(expbkt3): moved into @t3tools/client-runtime/state/phase-sidebar so
// the mobile home list shows the same lifecycle counters. Re-exported here so
// existing apps/web imports keep working.
export {
  summarizeSidebarSessions,
  threadIsRunning,
  threadNeedsHumanAttention,
  type SidebarSessionCountOptions,
  type SidebarSessionCounts,
} from "@t3tools/client-runtime/state/phase-sidebar";
