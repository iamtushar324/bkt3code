// T3-CUSTOM(expbkt3): how the experimental sidebar is sectioned — lifecycle,
// project, or custom groups — plus which sections are collapsed.
//
// A fork-owned store rather than a client setting: the shape is decided by
// client-runtime (which mobile shares), every edit is one of its pure
// operations, and keeping it here adds no hunks to an upstream-owned file.
// Only presentation lives here — the manual section order, collapse state and
// this device's legacy placements. Which group a session is IN is the thread's
// own `customGroup` label on the server, written through thread.meta.update.
import {
  createPhaseSidebarCustomGroup,
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  deletePhaseSidebarCustomGroup,
  movePhaseSidebarCustomGroup,
  prunePhaseSidebarGrouping,
  renamePhaseSidebarCustomGroup,
  sanitizePhaseSidebarGrouping,
  setPhaseSidebarGroupBy,
  setPhaseSidebarGroupOrder,
  togglePhaseSidebarSectionCollapsed,
  type PhaseSidebarGroupBy,
  type PhaseSidebarGroupOrder,
  type PhaseSidebarGroupingPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PHASE_SIDEBAR_GROUPING_STORAGE_KEY = "t3code:phase-sidebar-grouping:v1";

interface PhaseSidebarGroupingStoreState {
  readonly grouping: PhaseSidebarGroupingPreferences;
  setGroupBy: (groupBy: PhaseSidebarGroupBy) => void;
  setGroupOrder: (order: PhaseSidebarGroupOrder) => void;
  /** Registers an empty placeholder; returns its section id, or null when blank. */
  createGroup: (label: string) => string | null;
  /** Device-side half of a rename (order slot, collapse state, placeholder). */
  renameGroup: (id: string, label: string) => void;
  /** Device-side half of a delete. */
  forgetGroup: (id: string) => void;
  /** `orderedIds` is the custom section order currently on screen. */
  moveGroup: (orderedIds: ReadonlyArray<string>, id: string, direction: "up" | "down") => void;
  toggleSectionCollapsed: (sectionKey: string) => void;
  prune: (liveThreadKeys: ReadonlySet<string>) => void;
}

export const usePhaseSidebarGroupingStore = create<PhaseSidebarGroupingStoreState>()(
  persist(
    (set, get) => ({
      grouping: DEFAULT_PHASE_SIDEBAR_GROUPING,
      setGroupBy: (groupBy) =>
        set((state) => ({ grouping: setPhaseSidebarGroupBy(state.grouping, groupBy) })),
      setGroupOrder: (order) =>
        set((state) => ({ grouping: setPhaseSidebarGroupOrder(state.grouping, order) })),
      createGroup: (label) => {
        const result = createPhaseSidebarCustomGroup(get().grouping, { label });
        if (result.preferences !== get().grouping) set({ grouping: result.preferences });
        return result.id;
      },
      renameGroup: (id, label) =>
        set((state) => ({ grouping: renamePhaseSidebarCustomGroup(state.grouping, id, label) })),
      forgetGroup: (id) =>
        set((state) => ({ grouping: deletePhaseSidebarCustomGroup(state.grouping, id) })),
      moveGroup: (orderedIds, id, direction) =>
        set((state) => ({
          grouping: movePhaseSidebarCustomGroup(state.grouping, orderedIds, id, direction),
        })),
      toggleSectionCollapsed: (sectionKey) =>
        set((state) => ({
          grouping: togglePhaseSidebarSectionCollapsed(state.grouping, sectionKey),
        })),
      prune: (liveThreadKeys) =>
        set((state) => {
          const next = prunePhaseSidebarGrouping(state.grouping, liveThreadKeys);
          return next === state.grouping ? state : { grouping: next };
        }),
    }),
    {
      name: PHASE_SIDEBAR_GROUPING_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ grouping: state.grouping }),
      merge: (persisted, current) => ({
        ...current,
        grouping: sanitizePhaseSidebarGrouping(
          persisted && typeof persisted === "object"
            ? (persisted as { readonly grouping?: unknown }).grouping
            : undefined,
        ),
      }),
    },
  ),
);
