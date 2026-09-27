/**
 * T3-CUSTOM(expbkt3): Reclaiming an archived session's worktree.
 *
 * Upstream removes a worktree only when a thread is *deleted*, so the only way
 * to get the disk back is to destroy the session. These shapes describe the
 * middle ground: report what an archived session still occupies, write its
 * history somewhere durable, then give the space back while the thread stays
 * readable.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
// `SessionArchiveReclaimMode` lives in `settings.ts` because the auto-sweep
// setting stores one. It is re-exported from the package index there, so this
// module imports it rather than re-exporting and colliding with that barrel.
import { SessionArchiveReclaimMode } from "./settings.ts";

/**
 * What is left of the worktree right now.
 *
 * `slimmed` is inferred, not recorded: a checkout whose regenerable directories
 * are all absent looks exactly like one that was never built. Treating both as
 * `slimmed` is honest about the only thing that matters here — there is nothing
 * more to reclaim short of removing the worktree.
 */
export const SessionArchiveReclaimState = Schema.Literals([
  "present",
  "slimmed",
  "removed",
  "missing",
]);
export type SessionArchiveReclaimState = typeof SessionArchiveReclaimState.Type;

/**
 * Why an entry cannot be reclaimed. Rendered verbatim in the panel, so each
 * value has to read as a reason a person can act on.
 */
export const SessionArchiveBlockedReason = Schema.Literals([
  "not-archived",
  "worktree-shared",
  "worktree-live",
  "retention-window",
  "dirty-worktree",
  "unpushed-commits",
  "no-worktree",
  "not-a-managed-worktree",
]);
export type SessionArchiveBlockedReason = typeof SessionArchiveBlockedReason.Type;

/**
 * Gates an operator may deliberately override with `force`.
 *
 * These protect the operator's *own* uncommitted or unpushed work, so it is
 * theirs to discard. Everything absent from this list protects something else —
 * a worktree another live session is using, or one a running process sits in —
 * and no flag overrides those. Shared between tiers so the panel cannot offer a
 * force the server will refuse.
 */
export const FORCEABLE_BLOCKED_REASONS: ReadonlyArray<SessionArchiveBlockedReason> = [
  "dirty-worktree",
  "unpushed-commits",
];

const forceableReasons = new Set<string>(FORCEABLE_BLOCKED_REASONS);

export function isForceableBlockedReason(
  reason: SessionArchiveBlockedReason | null,
): reason is SessionArchiveBlockedReason {
  return reason !== null && forceableReasons.has(reason);
}

export const SessionArchiveEntry = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  /**
   * Display name of the owning project.
   *
   * Carried on the entry rather than looked up client-side: the archive can
   * contain threads whose project the client no longer lists, and "select every
   * worktree in this project" has to work for those too.
   */
  projectName: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Null when sizing was skipped or the path is gone, not zero — zero is a real size. */
  worktreeBytes: Schema.NullOr(NonNegativeInt),
  /** How much of `worktreeBytes` a `slim` would give back. */
  reclaimableBytes: Schema.NullOr(NonNegativeInt),
  reclaimState: SessionArchiveReclaimState,
  /** Null means a slim is allowed; otherwise the first failing gate. */
  blockedReason: Schema.NullOr(SessionArchiveBlockedReason),
  /**
   * The same evaluation for `remove`, which gates harder than `slim`.
   *
   * Reported separately because a worktree with uncommitted work is perfectly
   * fine to slim and refused for removal — collapsing the two would leave the
   * panel unable to say which button will actually do anything.
   */
  removeBlockedReason: Schema.NullOr(SessionArchiveBlockedReason).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Set once a history export exists on disk. */
  historyPath: Schema.NullOr(Schema.String),
});
export type SessionArchiveEntry = typeof SessionArchiveEntry.Type;

/**
 * A worktree directory with no thread pointing at it.
 *
 * Reported so an operator can see where the disk actually went, never reclaimed
 * automatically: nothing in the database can vouch for what these contain.
 */
export const SessionArchiveOrphanedWorktree = Schema.Struct({
  worktreePath: Schema.String,
  sizeBytes: Schema.NullOr(NonNegativeInt),
  lastModifiedAt: Schema.NullOr(IsoDateTime),
});
export type SessionArchiveOrphanedWorktree = typeof SessionArchiveOrphanedWorktree.Type;

export const SessionArchiveScanResult = Schema.Struct({
  scannedAt: IsoDateTime,
  entries: Schema.Array(SessionArchiveEntry),
  orphanedWorktrees: Schema.Array(SessionArchiveOrphanedWorktree),
  /** Sum over entries whose `blockedReason` is null. */
  totalReclaimableBytes: NonNegativeInt,
  historyDir: Schema.String,
  /** True when sizing hit its budget and some entries carry a null size. */
  sizingIncomplete: Schema.Boolean,
});
export type SessionArchiveScanResult = typeof SessionArchiveScanResult.Type;

export const SessionArchiveExportInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
});
export type SessionArchiveExportInput = typeof SessionArchiveExportInput.Type;

/**
 * One provider transcript file the export tried to preserve.
 *
 * `missing` is a normal outcome, not an error: old sessions whose provider
 * files were pruned, or whose resume cursor never resolved, still export
 * everything else. The record keeps the attempt honest either way.
 */
export const SessionArchiveRawTranscript = Schema.Struct({
  provider: Schema.String,
  sourcePath: Schema.String,
  /** Where the gzipped copy landed; null when `status` is not `copied`. */
  archivedPath: Schema.NullOr(Schema.String),
  status: Schema.Literals(["copied", "missing"]),
});
export type SessionArchiveRawTranscript = typeof SessionArchiveRawTranscript.Type;

export const SessionArchiveExportedFile = Schema.Struct({
  threadId: ThreadId,
  digestPath: Schema.String,
  transcriptPath: Schema.NullOr(Schema.String),
  messageCount: NonNegativeInt,
  /** Null when the activities sidecar is disabled. */
  activitiesPath: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  manifestPath: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  rawTranscripts: Schema.Array(SessionArchiveRawTranscript).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type SessionArchiveExportedFile = typeof SessionArchiveExportedFile.Type;

export const SessionArchiveExportResult = Schema.Struct({
  exported: Schema.Array(SessionArchiveExportedFile),
  failures: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      message: Schema.String,
    }),
  ),
});
export type SessionArchiveExportResult = typeof SessionArchiveExportResult.Type;

export const SessionArchiveReclaimInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
  mode: SessionArchiveReclaimMode,
  /**
   * Override the dirty-tree and unpushed-commit gates for `remove`. Never
   * overrides the shared-worktree or live-worktree gates: those protect other
   * sessions rather than the operator's own uncommitted work.
   */
  force: Schema.Boolean,
});
export type SessionArchiveReclaimInput = typeof SessionArchiveReclaimInput.Type;

export const SessionArchiveReclaimOutcome = Schema.Struct({
  threadId: ThreadId,
  reclaimed: Schema.Boolean,
  mode: SessionArchiveReclaimMode,
  freedBytes: NonNegativeInt,
  /** Null on success; a blocked gate or a failure message otherwise. */
  skippedReason: Schema.NullOr(Schema.String),
  digestPath: Schema.NullOr(Schema.String),
});
export type SessionArchiveReclaimOutcome = typeof SessionArchiveReclaimOutcome.Type;

export const SessionArchiveReclaimResult = Schema.Struct({
  outcomes: Schema.Array(SessionArchiveReclaimOutcome),
  totalFreedBytes: NonNegativeInt,
});
export type SessionArchiveReclaimResult = typeof SessionArchiveReclaimResult.Type;

/**
 * One-shot export of every archived or soft-deleted session that has no
 * history file yet. Counts rather than per-file records: a backfill touches
 * hundreds of threads and the caller only needs to know it converged.
 */
export const SessionArchiveBackfillInput = Schema.Struct({
  /** Re-export sessions whose digest already exists instead of skipping them. */
  force: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type SessionArchiveBackfillInput = typeof SessionArchiveBackfillInput.Type;

export const SessionArchiveBackfillResult = Schema.Struct({
  exported: NonNegativeInt,
  /** Digest already on disk and `force` was not set. */
  skipped: NonNegativeInt,
  /** Threads exported whose raw provider transcripts could not all be found. */
  rawTranscriptsMissing: NonNegativeInt,
  failures: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      message: Schema.String,
    }),
  ),
});
export type SessionArchiveBackfillResult = typeof SessionArchiveBackfillResult.Type;

/**
 * Whole-request failure only. A single thread that could not be reclaimed comes
 * back as a `skippedReason` on its outcome, so one bad entry never fails the
 * batch the operator selected.
 */
export class SessionArchiveError extends Schema.TaggedError<SessionArchiveError>()(
  "SessionArchiveError",
  {
    operation: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
  },
) {}

/**
 * T3-CUSTOM(expbkt3): On-demand context handoff for a single thread.
 *
 * Unlike the archive export above, this never touches disk: the server renders
 * a provider-neutral markdown digest of the session — metadata, rolling
 * summary, git state, and the transcript — and returns it as a string, so a
 * client can copy it or seed a new session's first prompt with it. Works for
 * live and archived threads alike; a session whose provider is erroring can
 * still be exported because nothing here consults the provider.
 */
export const ThreadContextExportInput = Schema.Struct({
  threadId: ThreadId,
});
export type ThreadContextExportInput = typeof ThreadContextExportInput.Type;

export const ThreadContextExportResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  /** The rendered handoff digest, ready to paste into any provider. */
  markdown: Schema.String,
  messageCount: NonNegativeInt,
  /** True when the transcript section was elided to fit the size cap. */
  truncated: Schema.Boolean,
});
export type ThreadContextExportResult = typeof ThreadContextExportResult.Type;
