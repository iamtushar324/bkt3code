/**
 * T3-CUSTOM(expbkt3): Which worktrees are off-limits because something is using them.
 *
 * Two distinct protections, easy to conflate and both load-bearing:
 *
 * - *Active* — some thread that is not archived points at the worktree.
 *   Reclaiming would pull the ground out from a session an operator still has
 *   open, even if nothing is running in it right now.
 * - *Live* — a provider session is actually running there. On this fork's
 *   deployment box the T3 servers themselves run out of worktrees, so this is
 *   the rule that stops a sweep from killing the server executing it.
 *
 * Pure so both can be asserted without a running orchestrator.
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { normalizeWorktreePath } from "./reclaimEligibility.ts";

/** Session states that mean a provider process is attached to the worktree. */
const LIVE_SESSION_STATUSES = new Set(["starting", "running", "ready"]);

export interface WorktreeUsage {
  readonly liveWorktreePaths: ReadonlySet<string>;
  readonly activeThreadWorktreePaths: ReadonlySet<string>;
}

function isLive(thread: OrchestrationThreadShell): boolean {
  if (thread.session !== null && LIVE_SESSION_STATUSES.has(thread.session.status)) {
    return true;
  }
  return false;
}

/**
 * Partition every thread's worktree into the two protected sets.
 *
 * Takes the *full* shell snapshot, archived threads included: an archived
 * thread whose session never stopped is still live, and excluding it here would
 * make the live gate miss exactly the case it exists for.
 */
export function collectWorktreeUsage(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): WorktreeUsage {
  const live = new Set<string>();
  const active = new Set<string>();

  for (const thread of threads) {
    const worktreePath = normalizeWorktreePath(thread.worktreePath);
    if (worktreePath === null) {
      continue;
    }
    if (isLive(thread)) {
      live.add(worktreePath);
    }
    if (thread.archivedAt === null) {
      active.add(worktreePath);
    }
  }

  return { liveWorktreePaths: live, activeThreadWorktreePaths: active };
}

/**
 * Worktrees the current server process is itself running from.
 *
 * Independent of thread state on purpose: the deployment worktree of a running
 * T3 Code server frequently has no thread pointing at it at all, so nothing in
 * the projection would protect it.
 */
export function serverOwnedWorktrees(input: {
  readonly serverCwd: string;
  readonly worktreesDir: string;
}): ReadonlySet<string> {
  const owned = new Set<string>();
  const cwd = normalizeWorktreePath(input.serverCwd);
  if (cwd === null) {
    return owned;
  }
  // The server's own directory is protected whether or not it sits under the
  // worktrees root. On this host the deployed servers run from main checkouts
  // outside it, and an earlier version of this function returned an empty set
  // for exactly that case — which let a reclaim delete the running
  // application's `node_modules`.
  owned.add(cwd);
  const root = normalizeWorktreePath(input.worktreesDir);
  if (root === null || !cwd.startsWith(`${root}/`)) {
    return owned;
  }
  // `<worktreesDir>/<project>/<worktree>` — protect the worktree directory
  // itself, whatever subdirectory the process happens to be sitting in.
  const relativeSegments = cwd
    .slice(root.length + 1)
    .split("/")
    .filter(Boolean);
  if (relativeSegments.length >= 2) {
    owned.add(`${root}/${relativeSegments[0]}/${relativeSegments[1]}`);
  }
  return owned;
}
