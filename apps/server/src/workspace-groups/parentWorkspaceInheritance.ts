/**
 * T3-CUSTOM(expbkt3): a child session works where its parent works.
 *
 * A session that delegates should not scatter worktrees. Left to the project
 * and app defaults, every child of one parent got its own tree — five children
 * of one session produced five checkouts of the same repository. The rule here
 * replaces that default, and only that default: anything the caller states
 * explicitly is honoured verbatim, which is also how a caller asks for an
 * isolated tree when children will edit in parallel.
 *
 * Same repository as the parent is answered from the parent's own row. A
 * different repository is answered by the group reservation in
 * `persistence/ThreadWorkspaceGroups`, because during a parallel fan-out no
 * sibling has a worktree to be observed yet.
 */
import type { Effect } from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** The parent facts this decision needs, as they appear on its shell row. */
export interface ParentWorkspaceOwner {
  readonly projectId: string;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export type ParentWorkspaceInheritance =
  /** Resolve through project then app defaults, exactly as before. */
  | { readonly kind: "none" }
  /** The parent's own worktree, which already exists on disk. */
  | {
      readonly kind: "parent-worktree";
      readonly path: string;
      readonly branch: string | null;
    }
  /** The parent runs in the project checkout rather than a worktree. */
  | { readonly kind: "parent-checkout" }
  /**
   * A different repository: allocate as before, but the identity that comes out
   * belongs to this parent's group for that repository.
   */
  | { readonly kind: "shared-group" };

/**
 * Where a newly created session should work, given who created it.
 *
 * `hasExplicitWorkspace` is the opt-out. It is true whenever the caller passed
 * any workspace at all — including `{ mode: "new-worktree" }`, which is how a
 * caller says "this child needs a tree of its own".
 */
export function resolveParentWorkspaceInheritance(input: {
  readonly hasExplicitWorkspace: boolean;
  readonly parentThreadId: string | null;
  readonly parent: ParentWorkspaceOwner | null;
  readonly targetProjectId: string;
}): ParentWorkspaceInheritance {
  if (input.hasExplicitWorkspace) return { kind: "none" };
  if (input.parentThreadId === null) return { kind: "none" };
  // An archived or unknown parent has no workspace to speak for. Falling back
  // to the defaults is safer than inheriting a path nothing is keeping alive.
  if (input.parent === null) return { kind: "none" };
  if (input.parent.projectId !== input.targetProjectId) return { kind: "shared-group" };
  if (input.parent.worktreePath === null) return { kind: "parent-checkout" };
  return {
    kind: "parent-worktree",
    path: input.parent.worktreePath,
    branch: input.parent.branch,
  };
}

/** Whether an accepted request should reserve or join its parent's group. */
export function shouldJoinParentWorkspaceGroup(input: {
  readonly hasExplicitWorkspace: boolean;
  readonly parentThreadId: string | null;
}): boolean {
  return !input.hasExplicitWorkspace && input.parentThreadId !== null;
}

// ---------------------------------------------------------------------------
// Serialising creation of one shared worktree
// ---------------------------------------------------------------------------

const worktreeCreationLocks = new Map<string, Semaphore.Semaphore>();

/**
 * Hold the lock for one worktree path while it is being created.
 *
 * Siblings in a group are handed the same branch and the same path, so without
 * this they race `git worktree add` and the loser fails on a path that now
 * exists. Keying on the path rather than on the group also covers the two
 * creation paths — the coordinator's and the durable reactor's — with one lock,
 * and is exactly as wide as the resource being contended.
 *
 * The lock is held over creation only, never over the setup script, so a
 * joining sibling waits for `git worktree add` and not for the parent project's
 * install step.
 */
export function withWorktreeCreationPermit<A, E, R>(
  worktreePath: string,
  effect: Effect<A, E, R>,
): Effect<A, E, R> {
  let lock = worktreeCreationLocks.get(worktreePath);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    worktreeCreationLocks.set(worktreePath, lock);
  }
  return lock.withPermits(1)(effect);
}

export function resetWorktreeCreationPermitsForTests(): void {
  worktreeCreationLocks.clear();
}
