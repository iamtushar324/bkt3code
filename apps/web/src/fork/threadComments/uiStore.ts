/**
 * T3-CUSTOM(expbkt3): transient UI state shared by the review-comment surfaces.
 *
 * The panel, the message highlights and the composer live in different
 * subtrees of `ChatView`, and two of the readers (the right-panel tab icon and
 * the composer's send gate) sit inside upstream components that know nothing
 * about the active thread. One small store carries the active thread's summary
 * and the hover/focus pairing between a card and its highlight, so each of
 * those readers is a single hook call rather than a threaded prop.
 */
import { create } from "zustand";

export interface ThreadCommentsActiveSummary {
  readonly threadKey: string;
  readonly openCount: number;
  readonly deliveryPaused: boolean;
  /** Setting on and the server advertises the capability. */
  readonly enabled: boolean;
  /** A turn is in flight; an empty send must not steer or queue. */
  readonly running: boolean;
}

interface ThreadCommentsUiState {
  readonly active: ThreadCommentsActiveSummary | null;
  readonly hoveredCommentId: string | null;
  /** Bumped on every focus request so the same card can be re-focused. */
  readonly focusRequest: { readonly commentId: string; readonly nonce: number } | null;
  readonly setActive: (summary: ThreadCommentsActiveSummary | null) => void;
  readonly setHovered: (commentId: string | null) => void;
  readonly focusComment: (commentId: string) => void;
  readonly clearFocus: () => void;
}

export const useThreadCommentsUiStore = create<ThreadCommentsUiState>((set) => ({
  active: null,
  hoveredCommentId: null,
  focusRequest: null,
  setActive: (active) =>
    set((state) =>
      state.active?.threadKey === active?.threadKey &&
      state.active?.openCount === active?.openCount &&
      state.active?.deliveryPaused === active?.deliveryPaused &&
      state.active?.enabled === active?.enabled &&
      state.active?.running === active?.running
        ? state
        : { active },
    ),
  setHovered: (hoveredCommentId) =>
    set((state) => (state.hoveredCommentId === hoveredCommentId ? state : { hoveredCommentId })),
  focusComment: (commentId) =>
    set((state) => ({
      focusRequest: { commentId, nonce: (state.focusRequest?.nonce ?? 0) + 1 },
    })),
  clearFocus: () => set({ focusRequest: null }),
}));

/** Open count for the active thread; feeds the tab badge without a thread ref. */
export function useActiveThreadCommentsOpenCount(): number {
  return useThreadCommentsUiStore((state) => (state.active?.enabled ? state.active.openCount : 0));
}

export function resetThreadCommentsUiStoreForTests() {
  useThreadCommentsUiStore.setState({ active: null, hoveredCommentId: null, focusRequest: null });
}
