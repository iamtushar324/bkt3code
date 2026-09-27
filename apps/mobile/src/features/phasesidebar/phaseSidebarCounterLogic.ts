// T3-CUSTOM(expbkt3): counter facts derived from the rendered phase rows.
import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";

/** Matches the rows eligible for the active sidebar's unread dot and summary. */
export function countPhaseSidebarUnreadRows(rows: ReadonlyArray<PhaseSidebarRow>): number {
  return rows.filter(
    (row) =>
      row.thread.archivedAt === null && row.thread.settledAt === null && row.isUnreadCompletion,
  ).length;
}
