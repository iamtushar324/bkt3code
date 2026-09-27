/**
 * T3-CUSTOM(expbkt3): which plan reviews the user has waved away.
 *
 * The takeover's visibility is derived, not stored: a plan is showing when its
 * review document exists and the user has not dismissed that document. Holding
 * only the dismissals — rather than an opened/dismissed pair — is what makes
 * "switch to a thread whose plan is still waiting and it opens there" fall out
 * for free instead of needing its own bookkeeping.
 *
 * Persisted, because closing a plan is a decision about that plan and a page
 * reload is not a change of mind. Deliberately kept out of `rightPanelStore`:
 * that store is persisted behind a versioned migration validator, and a new
 * field there would cost a version bump for state the right panel never reads.
 *
 * @module planReviewTakeoverStore
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PLAN_REVIEW_TAKEOVER_STORAGE_KEY = "t3code:plan-review-takeover:v1";

/**
 * Dismissals are append-only and a document is never un-dismissed, so the list
 * would otherwise grow for the life of the browser profile. Plans are reviewed
 * once; anything past the most recent few hundred can never be shown again.
 */
export const PLAN_REVIEW_DISMISSED_LIMIT = 200;

interface PlanReviewTakeoverState {
  readonly dismissedDocumentIds: ReadonlyArray<string>;
  dismiss: (documentId: string) => void;
  /** Asking for the plan again after closing it. See `removeDismissedDocumentId`. */
  undismiss: (documentId: string) => void;
  reset: () => void;
}

/**
 * Forget one dismissal, leaving the rest alone.
 *
 * Closing a plan is a decision about that plan, and so is asking for it back:
 * reopening must not clear the other plans the user has already waved away.
 */
export function removeDismissedDocumentId(
  dismissed: ReadonlyArray<string>,
  documentId: string,
): ReadonlyArray<string> {
  if (!dismissed.includes(documentId)) return dismissed;
  return dismissed.filter((entry) => entry !== documentId);
}

export function appendDismissedDocumentId(
  dismissed: ReadonlyArray<string>,
  documentId: string,
  limit: number = PLAN_REVIEW_DISMISSED_LIMIT,
): ReadonlyArray<string> {
  if (dismissed.includes(documentId)) return dismissed;
  const next = [...dismissed, documentId];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

export const usePlanReviewTakeoverStore = create<PlanReviewTakeoverState>()(
  persist(
    (set) => ({
      dismissedDocumentIds: [],
      dismiss: (documentId) =>
        set((state) => {
          const next = appendDismissedDocumentId(state.dismissedDocumentIds, documentId);
          return next === state.dismissedDocumentIds ? state : { dismissedDocumentIds: next };
        }),
      undismiss: (documentId) =>
        set((state) => {
          const next = removeDismissedDocumentId(state.dismissedDocumentIds, documentId);
          return next === state.dismissedDocumentIds ? state : { dismissedDocumentIds: next };
        }),
      reset: () => set({ dismissedDocumentIds: [] }),
    }),
    {
      name: PLAN_REVIEW_TAKEOVER_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ dismissedDocumentIds: state.dismissedDocumentIds }),
    },
  ),
);
