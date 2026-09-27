// T3-CUSTOM(expbkt3): moved into @t3tools/client-runtime/state/phase-sidebar so
// the mobile "move under session" sheet applies the same cycle guard.
// Re-exported here so existing apps/web imports keep working.
export {
  collectDescendantThreadIds,
  resolveMoveUnderCandidates,
  type MoveUnderCandidate,
} from "@t3tools/client-runtime/state/phase-sidebar";
