// T3-CUSTOM(expbkt3): which session subtrees are open in the experimental
// sidebar. A dedicated fork-owned store rather than a field on uiStateStore:
// the expansion set is exp-sidebar-only state, and keeping it here means the
// feature adds no hunks to an upstream-owned file.
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PHASE_SIDEBAR_TREE_STORAGE_KEY = "t3code:phase-sidebar-tree:v1";

interface PhaseSidebarTreeStoreState {
  /**
   * Expanded keys only. Children are hidden by default — a parent row already
   * reports its subtree through the count pill and the running rollup, so the
   * default view stays one row per unit of work.
   */
  readonly expandedKeys: ReadonlyArray<string>;
  toggle: (key: string) => void;
  setExpanded: (keys: string | ReadonlyArray<string>, expanded: boolean) => void;
}

function sanitizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

export const usePhaseSidebarTreeStore = create<PhaseSidebarTreeStoreState>()(
  persist(
    (set) => ({
      expandedKeys: [],
      toggle: (key) =>
        set((state) => ({
          expandedKeys: state.expandedKeys.includes(key)
            ? state.expandedKeys.filter((candidate) => candidate !== key)
            : [...state.expandedKeys, key],
        })),
      setExpanded: (keys, expanded) =>
        set((state) => {
          const target = typeof keys === "string" ? [keys] : keys;
          if (target.length === 0) return state;
          if (!expanded) {
            const removed = new Set(target);
            const next = state.expandedKeys.filter((candidate) => !removed.has(candidate));
            return next.length === state.expandedKeys.length ? state : { expandedKeys: next };
          }
          const additions = target.filter((key) => !state.expandedKeys.includes(key));
          return additions.length === 0
            ? state
            : { expandedKeys: [...state.expandedKeys, ...additions] };
        }),
    }),
    {
      name: PHASE_SIDEBAR_TREE_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ expandedKeys: state.expandedKeys }),
      merge: (persisted, current) => ({
        ...current,
        expandedKeys: sanitizeKeys(
          persisted && typeof persisted === "object"
            ? (persisted as { readonly expandedKeys?: unknown }).expandedKeys
            : undefined,
        ),
      }),
    },
  ),
);
