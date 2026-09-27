/**
 * T3-CUSTOM(expbkt3): Unattended reclaim of old archived sessions' worktrees.
 *
 * Off by default. When an operator turns it on, this walks the archive on a
 * timer and reclaims anything past the configured retention window, using the
 * same gates and the same export-before-delete ordering as the manual panel —
 * this adds a schedule, not a second set of rules.
 *
 * Settings are re-read every tick rather than captured at start, so switching
 * the sweep off takes effect at the next tick instead of needing a restart.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SessionArchiveService } from "./SessionArchiveService.ts";

/**
 * How often the sweep wakes up.
 *
 * Deliberately slow. The thing it reclaims accumulates over days, and each tick
 * costs a filesystem walk on a host that shares its IO with everything else.
 */
export const SWEEP_INTERVAL = Duration.hours(6);

export interface SessionArchiveSweeperShape {
  /** Start the background sweep within the provided scope. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SessionArchiveSweeper extends Context.Service<
  SessionArchiveSweeper,
  SessionArchiveSweeperShape
>()("t3/sessionArchive/SessionArchiveSweeper") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const archive = yield* SessionArchiveService;

  const tick = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const config = settings.experimental.sessionArchive;

    // Both switches, checked every tick: the feature itself, and the sweep.
    if (!config.enabled || !config.autoSweep.enabled) {
      return;
    }

    const result = yield* archive.sweep({
      mode: config.autoSweep.mode,
      minArchivedDays: config.autoSweep.minArchivedDays,
    });

    const reclaimed = result.outcomes.filter((outcome) => outcome.reclaimed);
    if (reclaimed.length === 0) {
      yield* Effect.logDebug("session-archive.sweep.no-op", {
        considered: result.outcomes.length,
      });
      return;
    }

    // Logged at info even though it is routine: this deletes from disk
    // without anyone watching, so there has to be a record of what went.
    yield* Effect.logInfo("session-archive.sweep.reclaimed", {
      mode: config.autoSweep.mode,
      minArchivedDays: config.autoSweep.minArchivedDays,
      reclaimedCount: reclaimed.length,
      skippedCount: result.outcomes.length - reclaimed.length,
      freedBytes: result.totalFreedBytes,
      threadIds: reclaimed.map((outcome) => outcome.threadId),
    });
  });

  const start: SessionArchiveSweeperShape["start"] = () =>
    forkParked(
      tick.pipe(
        Effect.catch((error: unknown) =>
          Effect.logWarning("session-archive.sweep.failed", { error }),
        ),
        Effect.catchDefect((defect: unknown) =>
          Effect.logWarning("session-archive.sweep.defect", { defect }),
        ),
        Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      ),
    );

  return { start } satisfies SessionArchiveSweeperShape;
});

export const layer = Layer.effect(SessionArchiveSweeper)(make);
