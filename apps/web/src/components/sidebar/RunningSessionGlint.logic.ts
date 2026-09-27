// T3-CUSTOM(expbkt3): moved into @t3tools/client-runtime/state/phase-sidebar.
// Only the decision is shared — web renders the emphasis as an animated glint,
// mobile renders it statically. Re-exported here so existing apps/web imports
// keep working.
export {
  isRunningSessionPhase,
  runningSessionDividerPhase,
  shouldShowRunningSessionGlint,
} from "@t3tools/client-runtime/state/phase-sidebar";
