/**
 * T3-CUSTOM(expbkt3): Whether an archived session's worktree may be reclaimed.
 *
 * This is the gate that keeps the feature from being destructive. Two of its
 * rules protect *other* people's work — a worktree shared with a live thread,
 * or one a session is running out of right now — and those are never
 * overridable. The rest protect the operator's own uncommitted work and can be
 * forced deliberately.
 *
 * Pure on purpose:
 * the service call site stays one line, and every gate is testable without a
 * filesystem, a git repository, or a running server.
 */
import type { SessionArchiveBlockedReason, SessionArchiveReclaimMode } from "@t3tools/contracts";

/** The subset of a thread shell this decision needs. */
export interface ReclaimThreadFacts {
  readonly threadId: string;
  readonly worktreePath: string | null;
  /** Null means the thread is not archived. */
  readonly archivedAt: string | null;
}

/** Git facts for the worktree, read once per scan. */
export interface ReclaimGitFacts {
  /** Tracked files with modifications, or staged changes. */
  readonly hasUncommittedChanges: boolean;
  /** Untracked, non-ignored files. Lost forever on a `remove`. */
  readonly hasUntrackedFiles: boolean;
  /** Commits on the branch that no remote has. */
  readonly hasUnpushedCommits: boolean;
}

export interface ReclaimEligibilityInput {
  readonly thread: ReclaimThreadFacts;
  readonly mode: SessionArchiveReclaimMode;
  /** Git facts, or null when the worktree is already gone from disk. */
  readonly git: ReclaimGitFacts | null;
  /**
   * Worktree paths in use by a running provider session or by a live T3
   * deployment. Reclaiming one of these kills a running process.
   */
  readonly liveWorktreePaths: ReadonlySet<string>;
  /** Worktree paths referenced by at least one thread that is *not* archived. */
  readonly activeThreadWorktreePaths: ReadonlySet<string>;
  /**
   * Root under which T3 provisions worktrees.
   *
   * Anything outside it is not a disposable worktree — a thread created in
   * non-worktree mode carries the project's *workspace root*, which is a main
   * checkout someone works in and, for the deployments on this host, the very
   * directory a server runs from.
   */
  readonly worktreesDir: string;
  /**
   * Retention floor, in days, applied to `archivedAt`. Zero disables it. The
   * panel passes zero (the operator is looking right at the session); the
   * sweeper passes the configured window.
   */
  readonly minArchivedDays: number;
  /** Now, as epoch milliseconds. Injected so the gate stays pure. */
  readonly nowMs: number;
  /**
   * Override the dirty-tree and unpushed-commit gates. Deliberately powerless
   * against the shared/live gates below.
   */
  readonly force: boolean;
}

export interface ReclaimEligibility {
  readonly eligible: boolean;
  readonly blockedReason: SessionArchiveBlockedReason | null;
}

const ELIGIBLE: ReclaimEligibility = { eligible: true, blockedReason: null };

const blocked = (blockedReason: SessionArchiveBlockedReason): ReclaimEligibility => ({
  eligible: false,
  blockedReason,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Normalize the way `worktreeCleanup.ts` does, so both tiers compare alike.
 *
 * Also collapses duplicate separators and strips a trailing one. Protection is
 * a string comparison, so `/w/proj/a/` failing to match `/w/proj/a` would be a
 * silent hole rather than a visible bug — the paths come from different writers
 * (thread creation, provisioning, hand-edited project files) and need not agree
 * on cosmetics.
 */
export function normalizeWorktreePath(path: string | null | undefined): string | null {
  const trimmed = path?.trim();
  if (!trimmed) {
    return null;
  }
  const collapsed = trimmed.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return collapsed.length > 0 ? collapsed : "/";
}

/**
 * Whether a path is a worktree T3 provisioned, rather than a checkout someone
 * merely opened a session against.
 *
 * A thread created in non-worktree mode stores the project's workspace root as
 * its `worktreePath`. Those are main checkouts — on the deployment host, the
 * directories the running servers are started from — and slimming one deletes
 * the live application's dependencies. Restricting every action to
 * `<worktreesDir>/<project>/<worktree>` is the invariant that makes the whole
 * feature safe by construction rather than by enumerating what to avoid.
 *
 * Requires at least two segments below the root, so the root itself and a bare
 * project directory are both rejected.
 */
export function isManagedWorktree(worktreePath: string, worktreesDir: string): boolean {
  const candidate = normalizeWorktreePath(worktreePath);
  const root = normalizeWorktreePath(worktreesDir);
  if (candidate === null || root === null) {
    return false;
  }
  if (!candidate.startsWith(`${root}/`)) {
    return false;
  }
  const segments = candidate
    .slice(root.length + 1)
    .split("/")
    .filter(Boolean);
  return segments.length >= 2;
}

/**
 * Whether reclaiming `worktreePath` would touch a protected worktree.
 *
 * Exact equality is not enough in either direction:
 *
 * - a protected worktree *nested inside* the candidate would be destroyed along
 *   with its parent;
 * - a candidate nested inside a protected worktree is a subdirectory of
 *   something in use.
 *
 * Both are rejected. Comparison is on path segments so `/w/proj/a` never
 * matches the unrelated sibling `/w/proj/a-backup`.
 */
export function isWorktreeProtected(
  worktreePath: string,
  protectedPaths: ReadonlySet<string>,
): boolean {
  const candidate = normalizeWorktreePath(worktreePath);
  if (candidate === null) {
    return false;
  }
  for (const raw of protectedPaths) {
    const guarded = normalizeWorktreePath(raw);
    if (guarded === null) {
      continue;
    }
    if (
      guarded === candidate ||
      guarded.startsWith(`${candidate}/`) ||
      candidate.startsWith(`${guarded}/`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether enough time has passed since archiving.
 *
 * An unparseable or missing `archivedAt` fails closed: a retention window we
 * cannot evaluate is not a window we may ignore.
 */
export function isPastRetention(input: {
  readonly archivedAt: string | null;
  readonly minArchivedDays: number;
  readonly nowMs: number;
}): boolean {
  if (input.minArchivedDays <= 0) {
    return true;
  }
  if (input.archivedAt === null) {
    return false;
  }
  const archivedMs = Date.parse(input.archivedAt);
  if (Number.isNaN(archivedMs)) {
    return false;
  }
  return input.nowMs - archivedMs >= input.minArchivedDays * MS_PER_DAY;
}

/**
 * Evaluate every gate in order and report the first that fails.
 *
 * Order matters for the message the operator sees: the un-overridable
 * protections are checked before the forceable ones, so "shared with a live
 * session" is never masked by "you have uncommitted changes".
 */
export function evaluateReclaimEligibility(input: ReclaimEligibilityInput): ReclaimEligibility {
  const { thread, mode, git, force } = input;

  if (thread.archivedAt === null) {
    return blocked("not-archived");
  }

  const worktreePath = normalizeWorktreePath(thread.worktreePath);
  if (worktreePath === null) {
    return blocked("no-worktree");
  }

  // The strongest gate, and the first: only ever touch a directory T3 itself
  // provisioned as a worktree. A thread created in non-worktree mode points at
  // the project's workspace root — a main checkout, which on this host is also
  // where the deployed servers run from. Slimming one of those deletes the
  // running application's `node_modules`.
  if (!isManagedWorktree(worktreePath, input.worktreesDir)) {
    return blocked("not-a-managed-worktree");
  }

  // Un-overridable: these protect work that is not the operator's to discard.
  // Containment-aware, so a nested worktree on either side still counts.
  if (isWorktreeProtected(worktreePath, input.liveWorktreePaths)) {
    return blocked("worktree-live");
  }
  if (isWorktreeProtected(worktreePath, input.activeThreadWorktreePaths)) {
    return blocked("worktree-shared");
  }

  if (
    !isPastRetention({
      archivedAt: thread.archivedAt,
      minArchivedDays: input.minArchivedDays,
      nowMs: input.nowMs,
    })
  ) {
    return blocked("retention-window");
  }

  // A slim only deletes regenerable, git-ignored directories, so uncommitted
  // work survives it. Removing the worktree does not, hence the extra gates.
  if (mode === "remove") {
    if (git === null) {
      return blocked("no-worktree");
    }
    if (!force && (git.hasUncommittedChanges || git.hasUntrackedFiles)) {
      return blocked("dirty-worktree");
    }
    if (!force && git.hasUnpushedCommits) {
      return blocked("unpushed-commits");
    }
  }

  return ELIGIBLE;
}

/**
 * Human-facing text for a gate. Kept beside the gates so a new reason cannot be
 * added without deciding what the panel will say about it.
 */
export function describeBlockedReason(reason: SessionArchiveBlockedReason): string {
  switch (reason) {
    case "not-archived":
      return "Only archived sessions can be reclaimed.";
    case "worktree-shared":
      return "Another active session still uses this worktree.";
    case "worktree-live":
      return "A session is running out of this worktree right now.";
    case "retention-window":
      return "Archived too recently for the configured retention window.";
    case "dirty-worktree":
      return "Uncommitted or untracked changes would be lost.";
    case "unpushed-commits":
      return "Commits here are not on any remote yet.";
    case "no-worktree":
      return "This session has no worktree on disk.";
    case "not-a-managed-worktree":
      return "This session works in a main checkout, not a T3-provisioned worktree.";
  }
}
