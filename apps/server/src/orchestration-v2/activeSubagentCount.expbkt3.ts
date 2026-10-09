// T3-CUSTOM(expbkt3): XFN-59 — count of running provider-native subagents for the BK sidebar.
import type {
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { pendingBackgroundTurnItems } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

type SubagentTurnItem = Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>;

/**
 * Provider-native subagents (Claude's Agent/Task tool, Codex, Cursor, OpenCode
 * native subagents) still working under a thread.
 *
 * The provider writes them as `subagent` turn items on the parent thread; their
 * child threads have no run of their own, so the child shell reads idle and
 * the parent turn item is the only live signal. `delegate_task` children
 * (`origin: "app_owned"`) are excluded: they are threads with their own runs,
 * which the sidebar already counts as child sessions.
 *
 * Activity and rollback follow `pendingBackgroundTurnItems`, the same filter
 * the Waiting roster and Stop use: an item counts while its status is pending,
 * running or waiting, and never when its run was rolled back. Unlike that
 * roster, the count does not wait for the run to settle, so subagents show
 * during the turn that started them. Items are deduplicated by `subagentId`.
 *
 * `runs` is optional for callers whose items are already filtered for
 * rolled-back runs (the SQL shell path); in-memory callers pass projection runs.
 */
export function countActiveProviderNativeSubagents(input: {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
}): number {
  const subagentIds = new Set<string>();
  for (const item of pendingBackgroundTurnItems(input)) {
    if (!isProviderNativeSubagentItem(item)) continue;
    subagentIds.add(String(item.subagentId));
  }
  return subagentIds.size;
}

/**
 * The shell field for a count. Omitted at zero, so shells without running
 * subagents keep their existing shape; clients read an absent field as 0.
 */
export function activeSubagentCountShellField(
  count: number | undefined,
): Pick<OrchestrationV2ThreadShell, "activeSubagentCount"> {
  return count === undefined || count <= 0 ? {} : { activeSubagentCount: count };
}

function isProviderNativeSubagentItem(item: OrchestrationV2TurnItem): item is SubagentTurnItem {
  return item.type === "subagent" && item.origin === "provider_native";
}
