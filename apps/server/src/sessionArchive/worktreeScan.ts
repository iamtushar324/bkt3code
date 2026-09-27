/**
 * T3-CUSTOM(expbkt3): Walking a worktree to size it and find what to slim.
 *
 * Sizing hundreds of worktrees is the expensive part of this feature — on the
 * box that motivated it, `du` over the whole worktrees directory took minutes
 * and this host has already had one IO-saturation incident. So the walk is
 * budgeted rather than exhaustive: it stops after a fixed number of entries and
 * reports that it stopped, which the panel surfaces instead of pretending the
 * number is complete.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  decideSlimCandidate,
  outermostCandidates,
  shouldDescendInto,
  type SlimCandidate,
} from "./slimTargets.ts";

/**
 * Directory entries visited before a single walk gives up.
 *
 * A fully installed monorepo worktree is well under this; a pathological one is
 * exactly the case we do not want to spend the box's IO budget on.
 */
export const WALK_ENTRY_BUDGET = 200_000;

export interface WorktreeScanResult {
  /** Total bytes, or null when the budget ran out before the walk finished. */
  readonly totalBytes: number | null;
  /** Bytes inside slim candidates — what a slim would actually give back. */
  readonly reclaimableBytes: number;
  readonly slimCandidates: ReadonlyArray<SlimCandidate>;
  readonly budgetExhausted: boolean;
}

const EMPTY_RESULT: WorktreeScanResult = {
  totalBytes: 0,
  reclaimableBytes: 0,
  slimCandidates: [],
  budgetExhausted: false,
};

/**
 * Sum a directory's apparent size.
 *
 * Symlinks are counted as their own (tiny) size and never followed: a link out
 * of the worktree would otherwise be billed to this session, and a cyclic one
 * would not terminate.
 */
const measureDirectory = Effect.fn("SessionArchive.measureDirectory")(function* (
  root: string,
  budget: { remaining: number },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let total = 0;
  const pending: Array<string> = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (budget.remaining <= 0) {
      return { bytes: total, exhausted: true };
    }

    const names = yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => []));
    for (const name of names) {
      budget.remaining -= 1;
      if (budget.remaining <= 0) {
        return { bytes: total, exhausted: true };
      }
      const child = path.join(current, name);
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (info._tag === "None") {
        continue;
      }
      const entry = info.value;
      if (entry.type === "Directory") {
        pending.push(child);
        continue;
      }
      if (entry.type === "File") {
        total += Number(entry.size);
      }
    }
  }

  return { bytes: total, exhausted: false };
});

/**
 * Walk a worktree once, collecting its size and its slim candidates.
 *
 * `trackedPaths` comes from `git ls-files`; it is what stops a project that
 * genuinely commits a `dist/` from having it deleted. Passing an empty set is
 * safe but conservative in the wrong direction, so callers should read git
 * first and only fall back to empty when the worktree is not a repository.
 */
export const scanWorktree = Effect.fn("SessionArchive.scanWorktree")(function* (input: {
  readonly worktreePath: string;
  readonly trackedPaths: ReadonlySet<string>;
  readonly entryBudget?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = yield* fs.exists(input.worktreePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return EMPTY_RESULT;
  }

  const budget = { remaining: input.entryBudget ?? WALK_ENTRY_BUDGET };
  const candidates: Array<SlimCandidate> = [];
  let totalBytes = 0;
  let exhausted = false;

  // Directories still to visit, as paths relative to the worktree root.
  const pending: Array<string> = [""];

  while (pending.length > 0 && !exhausted) {
    const relativeDir = pending.pop();
    if (relativeDir === undefined) break;

    const absoluteDir =
      relativeDir === "" ? input.worktreePath : path.join(input.worktreePath, relativeDir);
    const names = yield* fs.readDirectory(absoluteDir).pipe(Effect.orElseSucceed(() => []));

    for (const name of names) {
      budget.remaining -= 1;
      if (budget.remaining <= 0) {
        exhausted = true;
        break;
      }

      const relativePath = relativeDir === "" ? name : `${relativeDir}/${name}`;
      const absolutePath = path.join(input.worktreePath, relativePath);
      const info = yield* fs.stat(absolutePath).pipe(Effect.option);
      if (info._tag === "None") {
        continue;
      }
      const entry = info.value;

      if (entry.type === "File") {
        totalBytes += Number(entry.size);
        continue;
      }
      if (entry.type !== "Directory") {
        continue;
      }

      const candidate: SlimCandidate = { relativePath, name };
      if (decideSlimCandidate(candidate, input.trackedPaths).deletable) {
        candidates.push(candidate);
        // Size it as a unit; the walk does not descend into a directory it is
        // about to delete whole.
        const measured = yield* measureDirectory(absolutePath, budget);
        totalBytes += measured.bytes;
        exhausted = exhausted || measured.exhausted;
        continue;
      }

      if (shouldDescendInto(name)) {
        pending.push(relativePath);
        continue;
      }

      // Not descended into and not deletable — `.git`, or a target the tracked
      // guard vetoed. Still counts toward the total.
      const measured = yield* measureDirectory(absolutePath, budget);
      totalBytes += measured.bytes;
      exhausted = exhausted || measured.exhausted;
    }
  }

  const slimCandidates = outermostCandidates(candidates);
  let reclaimableBytes = 0;
  for (const candidate of slimCandidates) {
    const measured = yield* measureDirectory(
      path.join(input.worktreePath, candidate.relativePath),
      {
        remaining: WALK_ENTRY_BUDGET,
      },
    );
    reclaimableBytes += measured.bytes;
  }

  return {
    totalBytes: exhausted ? null : totalBytes,
    reclaimableBytes,
    slimCandidates,
    budgetExhausted: exhausted,
  } satisfies WorktreeScanResult;
});

/**
 * Delete a worktree's slim candidates.
 *
 * Re-checks each candidate against the tracked-path guard immediately before
 * deleting rather than trusting the scan's verdict: a scan result can be
 * minutes old by the time an operator clicks, and the cost of re-deciding is
 * nothing next to the cost of being wrong.
 */
export const slimWorktree = Effect.fn("SessionArchive.slimWorktree")(function* (input: {
  readonly worktreePath: string;
  readonly candidates: ReadonlyArray<SlimCandidate>;
  readonly trackedPaths: ReadonlySet<string>;
  /** Re-check Git immediately before each destructive removal. */
  readonly canDeleteCandidate?: (
    candidate: SlimCandidate,
    /** Proves this final guard runs only after the potentially long sizing walk. */
    measuredBytes: number,
  ) => Effect.Effect<boolean, never, GitVcsDriver | FileSystem.FileSystem | Path.Path>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let freedBytes = 0;
  for (const candidate of input.candidates) {
    if (!decideSlimCandidate(candidate, input.trackedPaths).deletable) {
      continue;
    }
    const absolutePath = path.join(input.worktreePath, candidate.relativePath);
    const measured = yield* measureDirectory(absolutePath, { remaining: WALK_ENTRY_BUDGET });
    // T3-CUSTOM(expbkt3): Sizing can walk 200k entries. Re-read Git after
    // that work and immediately beside remove so a file tracked during the
    // walk cannot be deleted from a stale approval.
    if (
      input.canDeleteCandidate !== undefined &&
      !(yield* input.canDeleteCandidate(candidate, measured.bytes))
    ) {
      continue;
    }
    const removed = yield* fs.remove(absolutePath, { recursive: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (removed) {
      freedBytes += measured.bytes;
    }
  }

  return freedBytes;
});
