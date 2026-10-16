/**
 * T3-CUSTOM(expbkt3): how wide plan cards are drawn.
 *
 * One reading preference for every plan, persisted: a reader who wants plans
 * wide wants the next plan wide too. "compact" keeps the card in the chat
 * column; "wide" lets it use the free width of the conversation area.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

export type PlanCardWidth = "compact" | "wide";

export const PLAN_CARD_WIDTH_STORAGE_KEY = "t3code:plan-card-width:v1";

interface PlanCardWidthState {
  readonly width: PlanCardWidth;
  toggle: () => void;
}

export const usePlanCardWidthStore = create<PlanCardWidthState>()(
  persist(
    (set) => ({
      width: "compact",
      toggle: () => set((state) => ({ width: state.width === "wide" ? "compact" : "wide" })),
    }),
    {
      name: PLAN_CARD_WIDTH_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ width: state.width }),
    },
  ),
);
