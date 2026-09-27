import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  reconcilePhaseSidebarFilters,
  sanitizePhaseSidebarFilters,
  sanitizePhaseSidebarSort,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseId,
  type PhaseSidebarSortDirection,
  type PhaseSidebarSortPreferences,
} from "./components/sidebar/PhaseGroupedSidebar.logic";
import { resolveStorage } from "./lib/storage";

export const PHASE_SIDEBAR_FILTER_STORAGE_KEY = "t3code:phase-sidebar-filters:v1";

interface PhaseSidebarFilterStoreState extends PhaseSidebarFilters {
  // T3-CUSTOM(expbkt3): in-group ordering lives beside the filters because both
  // shape the same list and are set from the same popover.
  readonly sort: PhaseSidebarSortPreferences;
  setSortDirection: (direction: PhaseSidebarSortDirection) => void;
  togglePriorityFirst: () => void;
  toggleRepository: (repositoryKey: string) => void;
  togglePhase: (phaseId: PhaseSidebarPhaseId) => void;
  toggleProvider: (providerKind: string) => void;
  // T3-CUSTOM(expbkt3): ownership, co-participant and custom group facets.
  toggleOwnedByMe: () => void;
  toggleParticipant: (userId: string) => void;
  toggleCustomGroup: (groupId: string) => void;
  clearAll: () => void;
  reconcile: (options: {
    readonly repositoryKeys: ReadonlySet<string>;
    readonly providerKinds: ReadonlySet<string>;
    readonly assignmentAvailable: boolean;
    readonly participantUserIds?: ReadonlySet<string>;
  }) => void;
}

function toggleValue<T extends string>(values: ReadonlyArray<T>, value: T): T[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export const usePhaseSidebarFilterStore = create<PhaseSidebarFilterStoreState>()(
  persist(
    (set) => ({
      ...EMPTY_PHASE_SIDEBAR_FILTERS,
      sort: DEFAULT_PHASE_SIDEBAR_SORT,
      setSortDirection: (direction) => set((state) => ({ sort: { ...state.sort, direction } })),
      togglePriorityFirst: () =>
        set((state) => ({ sort: { ...state.sort, priorityFirst: !state.sort.priorityFirst } })),
      toggleRepository: (repositoryKey) =>
        set((state) => ({ repositoryKeys: toggleValue(state.repositoryKeys, repositoryKey) })),
      togglePhase: (phaseId) =>
        set((state) => ({ phaseIds: toggleValue(state.phaseIds, phaseId) })),
      toggleProvider: (providerKind) =>
        set((state) => ({ providerKinds: toggleValue(state.providerKinds, providerKind) })),
      toggleOwnedByMe: () => set((state) => ({ ownedByMe: !state.ownedByMe })),
      toggleParticipant: (userId) =>
        set((state) => ({ participantUserIds: toggleValue(state.participantUserIds, userId) })),
      toggleCustomGroup: (groupId) =>
        set((state) => ({ customGroups: toggleValue(state.customGroups, groupId) })),
      clearAll: () => set(EMPTY_PHASE_SIDEBAR_FILTERS),
      reconcile: (options) => set((state) => reconcilePhaseSidebarFilters(state, options)),
    }),
    {
      name: PHASE_SIDEBAR_FILTER_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        repositoryKeys: state.repositoryKeys,
        phaseIds: state.phaseIds,
        providerKinds: state.providerKinds,
        ownedByMe: state.ownedByMe,
        participantUserIds: state.participantUserIds,
        customGroups: state.customGroups,
        sort: state.sort,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePhaseSidebarFilters(persisted),
        // Absent on blobs written before in-group sorting existed, so the
        // sanitizer's defaults carry those users onto the current behaviour.
        sort: sanitizePhaseSidebarSort(
          persisted && typeof persisted === "object"
            ? (persisted as { readonly sort?: unknown }).sort
            : undefined,
        ),
      }),
    },
  ),
);
