// T3-CUSTOM(expbkt3): line-range selection for the mobile plan-review screen.
//
// Deliberately the same interaction as the diff reviewer in `features/review`:
// the first tap anchors, a second tap extends, and tapping the anchor again
// clears. Reviewers move between the two surfaces and should not have to learn
// two gestures. The store is module-level and read through
// `useSyncExternalStore` for the same reason it is in `reviewCommentSelection`:
// the composer is a separate route and cannot receive the selection as a prop.
import { useSyncExternalStore } from "react";

export interface PlanReviewSelection {
  readonly documentId: string;
  /** 0-based inclusive line indices into the version on screen. */
  readonly startIndex: number;
  readonly endIndex: number;
  readonly quotedText: string;
}

let currentSelection: PlanReviewSelection | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

export function subscribePlanReviewSelection(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPlanReviewSelection(): PlanReviewSelection | null {
  return currentSelection;
}

export function setPlanReviewSelection(selection: PlanReviewSelection | null) {
  currentSelection = selection;
  emitChange();
}

export function clearPlanReviewSelection() {
  setPlanReviewSelection(null);
}

export function usePlanReviewSelection(): PlanReviewSelection | null {
  return useSyncExternalStore(
    subscribePlanReviewSelection,
    getPlanReviewSelection,
    getPlanReviewSelection,
  );
}

/**
 * The selection after tapping `lineIndex`, or null when the tap clears it.
 *
 * Pure so the interaction is testable without a renderer. A tap in a different
 * document replaces the selection rather than extending across documents.
 */
export function togglePlanReviewLine(input: {
  readonly current: PlanReviewSelection | null;
  readonly documentId: string;
  readonly lineIndex: number;
  readonly quoteFor: (startIndex: number, endIndex: number) => string;
}): PlanReviewSelection | null {
  const { current, documentId, lineIndex, quoteFor } = input;

  const startFresh = (): PlanReviewSelection => ({
    documentId,
    startIndex: lineIndex,
    endIndex: lineIndex,
    quotedText: quoteFor(lineIndex, lineIndex),
  });

  if (current === null || current.documentId !== documentId) return startFresh();

  // Tapping the single selected line again clears, so a mis-tap costs one tap.
  if (current.startIndex === lineIndex && current.endIndex === lineIndex) return null;

  // Tapping inside a multi-line selection collapses onto that line rather than
  // doing nothing, which is how the reviewer narrows a range.
  if (lineIndex >= current.startIndex && lineIndex <= current.endIndex) return startFresh();

  const startIndex = Math.min(current.startIndex, lineIndex);
  const endIndex = Math.max(current.endIndex, lineIndex);
  return { documentId, startIndex, endIndex, quotedText: quoteFor(startIndex, endIndex) };
}

/** Label for the selection action bar. */
export function formatPlanReviewSelectionLabel(selection: PlanReviewSelection): string {
  const count = selection.endIndex - selection.startIndex + 1;
  return count === 1
    ? `Line ${selection.startIndex + 1}`
    : `Lines ${selection.startIndex + 1}-${selection.endIndex + 1}`;
}
