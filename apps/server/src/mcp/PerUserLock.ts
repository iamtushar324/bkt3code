/**
 * T3-CUSTOM(expbkt3): One mutex per user id, created on first use.
 *
 * Profile and credential writes are read-modify-write over one SQLite row and
 * one secret file, and the toolyard connect flow rotates a remote token before
 * it writes. Running two of either for the same user at once would let a
 * later response overwrite an earlier one out of order, so every such path
 * takes this lock. Locks are process-wide and never dropped; the set of users
 * is small and bounded.
 */
import type * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface PerUserLock {
  readonly withLock: <A, E, R>(
    userId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

export const makePerUserLock = (): PerUserLock => {
  const locks = new Map<string, Semaphore.Semaphore>();
  return {
    withLock: (userId, effect) => {
      let lock = locks.get(userId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(userId, lock);
      }
      return lock.withPermit(effect);
    },
  };
};
