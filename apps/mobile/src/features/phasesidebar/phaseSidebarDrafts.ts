// T3-CUSTOM(expbkt3): stock mobile new-task drafts in the experimental sidebar.
import type { PendingDraftTask, PendingNewTask } from "../../state/pending-new-tasks-model";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PhaseSidebarHostFilters } from "./phaseSidebarHostFilters";

// The existing grouping preference persists arbitrary section keys. Drafts are
// outside lifecycle/project/custom grouping, so one key survives mode changes.
export const PHASE_SIDEBAR_DRAFTS_SECTION_KEY = "section:drafts";

export type PhaseSidebarDraftListItem =
  | {
      readonly kind: "drafts-section";
      readonly key: string;
      readonly count: number;
      readonly collapsed: boolean;
    }
  | { readonly kind: "draft"; readonly key: string; readonly draft: PendingDraftTask };

/** Match the normal sidebar's scope and title search for unsent new tasks. */
export function selectPhaseSidebarDrafts(
  tasks: ReadonlyArray<PendingNewTask>,
  filters: PhaseSidebarHostFilters,
): ReadonlyArray<PendingDraftTask> {
  const query = filters.searchQuery.trim().toLocaleLowerCase();
  return tasks.filter(
    (task): task is PendingDraftTask =>
      task.kind === "draft" &&
      (filters.selectedEnvironmentId === null ||
        task.environmentId === filters.selectedEnvironmentId) &&
      (filters.selectedProjectKeys === null ||
        filters.selectedProjectKeys.has(scopedProjectKey(task.environmentId, task.projectId))) &&
      (query.length === 0 || task.title.toLocaleLowerCase().includes(query)),
  );
}

export function buildPhaseSidebarDraftItems(
  drafts: ReadonlyArray<PendingDraftTask>,
  collapsedSectionKeys: ReadonlySet<string>,
): ReadonlyArray<PhaseSidebarDraftListItem> {
  if (drafts.length === 0) return [];
  const collapsed = collapsedSectionKeys.has(PHASE_SIDEBAR_DRAFTS_SECTION_KEY);
  return [
    {
      kind: "drafts-section",
      key: PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
      count: drafts.length,
      collapsed,
    },
    ...(collapsed
      ? []
      : drafts.map((draft) => ({ kind: "draft" as const, key: draft.key, draft }))),
  ];
}
