/**
 * T3-CUSTOM(expbkt3): which agent view, if any, is expanded over the transcript.
 *
 * Deliberately not persisted: each thread remembers its expanded view while
 * navigation only changes which thread’s view is visible. Keeping it in a store
 * rather than in the timeline row is what lets the
 * overlay mount beside the message list — outside the virtualized rows, which
 * clip and recycle — while the card that opened it stays a plain row.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";

import type { ScopedThreadRef } from "@t3tools/contracts";

export interface ExpandedAgentUiView {
  readonly threadRef: ScopedThreadRef;
  readonly renderId: string;
}

interface AgentUiExpandedStoreState {
  readonly expandedByThread: Readonly<Record<string, ExpandedAgentUiView>>;
  expand: (view: ExpandedAgentUiView) => void;
  collapse: (threadRef: ScopedThreadRef) => void;
}

export function selectExpandedAgentUiView(
  state: AgentUiExpandedStoreState,
  threadRef: ScopedThreadRef | null,
): ExpandedAgentUiView | null {
  return threadRef ? (state.expandedByThread[scopedThreadKey(threadRef)] ?? null) : null;
}

export const useAgentUiExpandedStore = create<AgentUiExpandedStoreState>((set) => ({
  expandedByThread: {},
  expand: (view) =>
    set((state) => ({
      expandedByThread: { ...state.expandedByThread, [scopedThreadKey(view.threadRef)]: view },
    })),
  collapse: (threadRef) =>
    set((state) => {
      const key = scopedThreadKey(threadRef);
      if (!(key in state.expandedByThread)) return state;
      const expandedByThread = { ...state.expandedByThread };
      delete expandedByThread[key];
      return { expandedByThread };
    }),
}));
