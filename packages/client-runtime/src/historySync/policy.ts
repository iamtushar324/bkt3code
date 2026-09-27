/**
 * T3-CUSTOM(expbkt3): decide when to pull another page of older history.
 *
 * The client only caches the window it has actually loaded — roughly the last
 * ten user turns — which is enough to render a thread but thin as the basis of
 * a handoff once the host goes away. This walks the existing pagination
 * backwards while the host is reachable, so the cached copy of a session the
 * operator is actually working in deepens on its own.
 *
 * It is a policy, not a loop: the caller asks after every state change, and the
 * answer is derived from state the pagination machinery already publishes. That
 * keeps the deepening event-driven — each merged page changes the page state,
 * which asks again — instead of polling a host on a timer.
 *
 * The budget exists because a cache is not an archive. Past a few hundred turns
 * the marginal value to a handoff is near zero (the digest's own transcript cap
 * is far smaller), while the cost in memory, storage, and host round-trips is
 * not.
 *
 * @module historySync/policy
 */
import type { EnvironmentThreadPageState, EnvironmentThreadStatus } from "../state/threadState.ts";

/**
 * How many user turns are worth keeping cached per thread.
 *
 * Comfortably above the handoff digest's own transcript budget, so a digest
 * built offline is limited by the digest's cap rather than by the cache, and
 * well under the server's 2000-message projection cap.
 */
export const DEFAULT_HISTORY_SYNC_BUDGET_USER_TURNS = 200;

export interface HistorySyncDecisionInput {
  /** Only a live thread is synchronized: a cached one has no host to ask. */
  readonly status: EnvironmentThreadStatus;
  readonly page: EnvironmentThreadPageState | null;
  readonly loadedUserTurns: number;
  readonly budgetUserTurns?: number;
  /**
   * A running turn keeps the thread busy: pages merged now are not persisted
   * until the turn settles, so deepening only adds memory and render weight.
   */
  readonly sessionRunning?: boolean;
  /** A hidden window has nobody reading it; deepen once it is visible again. */
  readonly documentVisible?: boolean;
}

export function shouldRequestOlderPage(input: HistorySyncDecisionInput): boolean {
  const budget = input.budgetUserTurns ?? DEFAULT_HISTORY_SYNC_BUDGET_USER_TURNS;
  if (input.status !== "live") {
    return false;
  }
  if (input.sessionRunning === true || input.documentVisible === false) {
    return false;
  }
  if (input.page === null || !input.page.hasMore || input.page.loadingOlder) {
    return false;
  }
  // A page request without a cursor has nothing to ask for; the "load earlier"
  // control is in the same position and does not fire either.
  if (input.page.beforeCursor === null) {
    return false;
  }
  return input.loadedUserTurns < budget;
}

/** User turns are what the pagination window is measured in. */
export function countUserTurns(messages: ReadonlyArray<{ readonly role: string }>): number {
  return messages.reduce((total, message) => (message.role === "user" ? total + 1 : total), 0);
}
