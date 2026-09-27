// T3-CUSTOM(expbkt3): stock Home scopes applied before phase grouping.
//
// The phase sidebar owns lifecycle facets, while Home owns the environment,
// project and search controls. Keeping this small adapter separate means both
// Home hosts pass the same resolved scope without duplicating filter rules.
import type { EnvironmentId } from "@t3tools/contracts";
import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";

import { scopedProjectKey } from "../../lib/scopedEntities";

export interface PhaseSidebarHostFilters {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKeys: ReadonlySet<string> | null;
  readonly searchQuery: string;
  /** Message-search hits from Home's server-backed search query. */
  readonly matchedThreadKeys: ReadonlySet<string>;
}

/**
 * Narrows phase rows by the controls Home already exposes. Lifecycle filters
 * still run afterwards in `PhaseSidebarList`, so the two filter surfaces
 * compose instead of replacing one another.
 */
export function filterPhaseSidebarRowsForHost(
  rows: ReadonlyArray<PhaseSidebarRow>,
  filters: PhaseSidebarHostFilters,
): ReadonlyArray<PhaseSidebarRow> {
  const query = filters.searchQuery.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    const { thread } = row;
    if (
      filters.selectedEnvironmentId !== null &&
      thread.environmentId !== filters.selectedEnvironmentId
    ) {
      return false;
    }
    if (
      filters.selectedProjectKeys !== null &&
      !filters.selectedProjectKeys.has(scopedProjectKey(thread.environmentId, thread.projectId))
    ) {
      return false;
    }
    if (query.length === 0) return true;
    return (
      thread.title.toLocaleLowerCase().includes(query) ||
      row.repositoryLabel.toLocaleLowerCase().includes(query) ||
      filters.matchedThreadKeys.has(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      )
    );
  });
}
