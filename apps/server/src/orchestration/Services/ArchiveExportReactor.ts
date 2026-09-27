/**
 * ArchiveExportReactor - Archive-time session history export reactor interface.
 *
 * T3-CUSTOM(expbkt3): Owns the background worker that reacts to
 * `thread.archived` domain events and writes the session's durable history —
 * digest, transcript and activity sidecars, metadata manifest, and raw
 * provider transcripts — before the worktree mapping those transcripts depend
 * on can be reclaimed.
 *
 * @module ArchiveExportReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ArchiveExportReactorShape - Service API for archive-time history export.
 */
export interface ArchiveExportReactorShape {
  /**
   * Start reacting to thread.archived orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * ArchiveExportReactor - Service tag for archive-time history export workers.
 */
export class ArchiveExportReactor extends Context.Service<
  ArchiveExportReactor,
  ArchiveExportReactorShape
>()("t3/orchestration/Services/ArchiveExportReactor") {}
