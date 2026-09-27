// T3-CUSTOM(expbkt3): moved into @t3tools/client-runtime/state/phase-sidebar so
// mobile can decide "unread" the same way. Re-exported here so existing
// apps/web imports keep working.
export {
  resolveThreadVisitTimestamp,
  type ThreadVisitTimestampInput,
} from "@t3tools/client-runtime/state/phase-sidebar";
