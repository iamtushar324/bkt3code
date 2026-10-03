/**
 * T3-CUSTOM(expbkt3): Whether and how a thread's missing worktree directory
 * can be rebuilt before a provider session starts.
 *
 * A worktree can disappear out from under a live thread — external cleanup,
 * a disk incident, a manual `git worktree remove`. The thread keeps pointing
 * at the dead path, so without recovery every session start fails with the
 * same ENOENT until a human intervenes. The recorded branch survives such
 * deletions far more often than the directory, and a branch plus the project
 * workspace root is everything `git worktree add` needs to rebuild the
 * directory in place.
 *
 * Pure on purpose, in the style of `../sessionArchive/reclaimEligibility.ts`:
 * the reactor call site stays small, and every branch of the decision is
 * testable without a filesystem, a git repository, or a running server.
 *
 * The `unrecoverable` details deliberately phrase the problem as
 * "worktree … is missing" so `durableRecoveryFailure` classifies the
 * resulting turn-start failure as permanent instead of retrying it.
 */

/** The subset of thread + project state this decision needs. */
export interface WorktreeRecoveryFacts {
  /** The thread's recorded worktree path, already known to be missing on disk. */
  readonly worktreePath: string;
  /** The thread's recorded branch, or null when none was ever recorded. */
  readonly branch: string | null;
  /** Whether that branch still exists in the project repository. */
  readonly branchExists: boolean;
  /** The project's workspace root, or null when the project is unknown. */
  readonly workspaceRoot: string | null;
}

export type WorktreeRecoveryDecision =
  | {
      readonly kind: "recreate";
      readonly workspaceRoot: string;
      readonly branch: string;
      readonly worktreePath: string;
    }
  | { readonly kind: "unrecoverable"; readonly detail: string };

export function decideWorktreeRecovery(facts: WorktreeRecoveryFacts): WorktreeRecoveryDecision {
  if (facts.workspaceRoot === null) {
    return {
      kind: "unrecoverable",
      detail: `Worktree '${facts.worktreePath}' is missing and the thread's project workspace root is unknown, so the worktree cannot be rebuilt automatically.`,
    };
  }
  if (facts.branch === null) {
    return {
      kind: "unrecoverable",
      detail: `Worktree '${facts.worktreePath}' is missing and the thread has no recorded branch to rebuild it from.`,
    };
  }
  if (!facts.branchExists) {
    return {
      kind: "unrecoverable",
      detail: `Worktree '${facts.worktreePath}' is missing and its branch '${facts.branch}' no longer exists in '${facts.workspaceRoot}'. Recreate the branch, or start a new session for this work.`,
    };
  }
  return {
    kind: "recreate",
    workspaceRoot: facts.workspaceRoot,
    branch: facts.branch,
    worktreePath: facts.worktreePath,
  };
}

/**
 * User-facing notice for a successful in-place recreation. Uncommitted changes
 * only ever lived in the deleted directory, so the user must learn their
 * working tree was reset even though the session recovered.
 */
export function describeWorktreeRecreation(input: {
  readonly worktreePath: string;
  readonly branch: string;
}): string {
  return `The worktree directory '${input.worktreePath}' was missing and has been recreated from branch '${input.branch}'. Uncommitted changes that only existed in the deleted directory could not be restored.`;
}
