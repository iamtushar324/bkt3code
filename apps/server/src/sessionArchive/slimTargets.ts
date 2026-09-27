/**
 * T3-CUSTOM(expbkt3): Which directories inside a worktree are regenerable.
 *
 * "Slimming" a worktree means deleting what a package manager or build tool can
 * put back, and nothing else. The checkout stays valid, `git status` stays
 * clean, and reopening the session costs an install rather than a clone.
 *
 * Pure on purpose: the decision about what may be deleted is the dangerous part
 * of this feature, so it is testable without touching a filesystem.
 */

/**
 * Directory names deleted at any depth below the worktree root.
 *
 * Every entry has to satisfy two things: a standard tool recreates it, and it
 * is conventionally git-ignored. `target` is the widest of these — it is Rust's
 * build directory but a plausible source directory name elsewhere — so the
 * tracked-path guard below, not this list, is what makes it safe.
 */
export const SLIM_TARGET_DIRECTORY_NAMES: ReadonlyArray<string> = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".parcel-cache",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "coverage",
  "target",
  ".gradle",
  ".cargo-target",
];

/**
 * Never descended into, whatever else matches.
 *
 * `.git` holds the worktree's link to the repository; deleting anything under
 * it turns a slim into a corruption. The rest are directories a match inside
 * would be meaningless for — a `node_modules` nested under another
 * `node_modules` is removed with its parent anyway.
 */
export const SLIM_EXCLUDED_DIRECTORY_NAMES: ReadonlyArray<string> = [".git"];

const targetNames = new Set(SLIM_TARGET_DIRECTORY_NAMES);
const excludedNames = new Set(SLIM_EXCLUDED_DIRECTORY_NAMES);

export interface SlimCandidate {
  /** Path relative to the worktree root, using forward slashes. */
  readonly relativePath: string;
  readonly name: string;
}

export interface SlimDecision {
  readonly deletable: boolean;
  readonly reason:
    | "regenerable"
    | "not-a-target"
    | "excluded-directory"
    | "git-tracked"
    | "escapes-worktree";
}

/** Split a relative path the same way for every check below. */
function segmentsOf(relativePath: string): ReadonlyArray<string> {
  return relativePath.split("/").filter((segment) => segment.length > 0);
}

/**
 * Decide whether one directory may be deleted.
 *
 * `trackedPaths` are the repository's tracked paths relative to the worktree
 * root (`git ls-files`). A directory containing tracked files is never
 * regenerable no matter what it is called — that is what stops a project which
 * genuinely commits its `dist/` from being gutted.
 */
export function decideSlimCandidate(
  candidate: SlimCandidate,
  trackedPaths: ReadonlySet<string>,
): SlimDecision {
  const segments = segmentsOf(candidate.relativePath);

  // `..` can only appear if a caller handed us a path outside the root.
  if (segments.length === 0 || segments.includes("..")) {
    return { deletable: false, reason: "escapes-worktree" };
  }
  if (segments.some((segment) => excludedNames.has(segment))) {
    return { deletable: false, reason: "excluded-directory" };
  }
  if (!targetNames.has(candidate.name)) {
    return { deletable: false, reason: "not-a-target" };
  }

  const prefix = `${segments.join("/")}/`;
  for (const tracked of trackedPaths) {
    if (tracked === candidate.relativePath || tracked.startsWith(prefix)) {
      return { deletable: false, reason: "git-tracked" };
    }
  }

  return { deletable: true, reason: "regenerable" };
}

/**
 * Whether a walk should descend into a directory.
 *
 * A matched target is not descended into: it is deleted whole, and its children
 * would only produce redundant candidates.
 */
export function shouldDescendInto(name: string): boolean {
  return !excludedNames.has(name) && !targetNames.has(name);
}

/**
 * Reduce candidates to the outermost ones.
 *
 * A walk that does not honour {@link shouldDescendInto} can surface nested
 * matches; deleting the parent already removes the child, and attempting the
 * child afterwards would fail on a missing path.
 */
export function outermostCandidates(
  candidates: ReadonlyArray<SlimCandidate>,
): ReadonlyArray<SlimCandidate> {
  const sorted = [...candidates].sort(
    (left, right) => left.relativePath.length - right.relativePath.length,
  );
  const kept: Array<SlimCandidate> = [];
  for (const candidate of sorted) {
    const nested = kept.some((existing) =>
      candidate.relativePath.startsWith(`${existing.relativePath}/`),
    );
    if (!nested) {
      kept.push(candidate);
    }
  }
  return kept;
}
