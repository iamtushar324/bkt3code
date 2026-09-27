import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEngine from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  interruptRunningSession,
  latestThreadEventAt,
  listRunningSessionRows,
  settleRunningSession,
} from "../../orchestration/reconcileRunningTurns.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
// T3-CUSTOM(expbkt3): the sweep lists only bindings it can act on.
import { listLiveProviderBindings } from "../liveProviderBindings.expbkt3.ts";
import { ProviderService } from "../Services/ProviderService.ts";
// T3-CUSTOM(expbkt3): BEGIN - OS-level sweep for leaked provider runtimes.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  increment,
  providerRuntimeOrphanProcessesKilledTotal,
} from "../../observability/Metrics.ts";
import {
  collectAncestorPids,
  readOwnCgroupProcessIds,
  snapshotProcesses,
  supportsProcessTreeInspection,
  terminateProcessTree,
} from "../processTree.ts";
import {
  listProviderRuntimeProcesses,
  selectOrphanProviderProcesses,
  unregisterProviderRuntimeProcess,
} from "../providerRuntimeProcesses.ts";
// T3-CUSTOM(expbkt3): END

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
export const PROVIDER_SESSION_INACTIVITY_ENV = "T3CODE_PROVIDER_SESSION_INACTIVITY_MS";
export const providerSessionInactivityThresholdConfig = Config.int(
  PROVIDER_SESSION_INACTIVITY_ENV,
).pipe(
  Config.withDefault(DEFAULT_INACTIVITY_THRESHOLD_MS),
  Config.mapOrFail((value) =>
    value > 0
      ? Effect.succeed(value)
      : Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `${PROVIDER_SESSION_INACTIVITY_ENV} must be a positive integer.`,
            }),
          ),
        ),
  ),
);
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Last-resort backstop for a turn that is still "running" with a live provider
 * session but has clearly gone nowhere. Deliberately generous: silence is not
 * evidence of death (see reconcileRunningTurns), so this must never be the
 * mechanism that ends a normal turn.
 *
 * T3-CUSTOM(expbkt3): measured against the thread's last recorded event, not
 * the turn start. Agents here legitimately run multi-hour monitoring turns that
 * emit steadily; a turn that is still producing events has not "gone nowhere",
 * and capping it by age alone started the settle/recover loop of 2026-08-20.
 */
const DEFAULT_TURN_ABSOLUTE_CAP_MS = 2 * 60 * 60 * 1000;
/**
 * A turn must have been running at least this long before "no in-memory
 * session" counts as proof of death, so a session that is mid-registration is
 * never mistaken for an orphan.
 */
const ORPHAN_EVIDENCE_GRACE_MS = 5 * 60 * 1000;
// T3-CUSTOM(expbkt3): BEGIN - OS orphan sweep tuning.
/** SIGTERM grace before a leaked provider runtime process is SIGKILLed. */
const ORPHAN_PROCESS_GRACE_MS = 5 * 1000;
/**
 * How long a runtime PID we spawned may exist without a matching live session
 * before it counts as abandoned. Comfortably longer than session startup, so a
 * runtime whose session has not been published yet is never reaped.
 */
const TRACKED_ORPHAN_GRACE_MS = 5 * 60 * 1000;
// T3-CUSTOM(expbkt3): END

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly turnAbsoluteCapMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    // Captured here (rather than inside the sweep) so the orphan pass does not
    // leak these requirements into `start()`, whose context is Scope-only.
    const reconcileContext = yield* Effect.context<
      Crypto.Crypto | OrchestrationEngine.OrchestrationEngineService | SqlClient.SqlClient
    >();

    const inactivityThresholdMs =
      options?.inactivityThresholdMs ?? (yield* providerSessionInactivityThresholdConfig);
    if (inactivityThresholdMs <= 0) {
      return yield* Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message: "Provider session inactivity threshold must be positive.",
          }),
        ),
      );
    }
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const turnAbsoluteCapMs = Math.max(
      1,
      options?.turnAbsoluteCapMs ?? DEFAULT_TURN_ABSOLUTE_CAP_MS,
    );

    /**
     * Settle threads still marked running whose agent is provably gone.
     *
     * The plain session reaper below can never do this: it skips any thread
     * with an active turn, which is exactly the stuck case. Evidence here is
     * "the adapters hold no in-memory session for this thread" — never silence,
     * because a healthy agent can emit nothing for the whole of a long tool
     * call.
     */
    const sweepOrphanedTurns = Effect.gen(function* () {
      const rows = yield* listRunningSessionRows;

      if (rows.length === 0) {
        return;
      }

      const liveThreadIds = new Set(
        (yield* providerService.listSessions()).map((session) => String(session.threadId)),
      );
      const now = yield* Clock.currentTimeMillis;

      for (const row of rows) {
        const startedMs = Date.parse(row.turnStartedAt ?? row.updatedAt);
        const runningForMs = Number.isNaN(startedMs) ? 0 : now - startedMs;
        // T3-CUSTOM(expbkt3): silence, not age, is what the cap measures.
        const lastActivityMs = Date.parse(row.lastActivityAt ?? row.turnStartedAt ?? row.updatedAt);
        const silentForMs = Number.isNaN(lastActivityMs) ? runningForMs : now - lastActivityMs;
        const sessionLive = liveThreadIds.has(row.threadId);

        const reason = !sessionLive
          ? runningForMs >= ORPHAN_EVIDENCE_GRACE_MS
            ? "Interrupted: the agent session is no longer running."
            : null
          : silentForMs >= turnAbsoluteCapMs
            ? `Interrupted: the turn produced no events for ${Math.round(turnAbsoluteCapMs / 60_000)} minutes.`
            : null;

        if (reason === null) {
          continue;
        }

        // T3-CUSTOM(expbkt3): a live-but-silent turn is interrupted for real
        // first, so the durable work item is terminal and the provider is told
        // to stop before the projection is settled. Settling alone re-armed
        // durable recovery against the still-running provider turn.
        if (sessionLive) {
          yield* interruptRunningSession({ row, reason }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.interrupt-silent-turn-failed", {
                threadId: row.threadId,
                cause,
              }),
            ),
          );
        }

        yield* settleRunningSession({ row, reason }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaper.settled-orphaned-turn", {
              threadId: row.threadId,
              runningForMs,
              silentForMs,
              reason,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.settle-orphaned-turn-failed", {
              threadId: row.threadId,
              cause,
            }),
          ),
        );
      }
    }).pipe(Effect.provide(reconcileContext));

    // T3-CUSTOM(expbkt3): BEGIN - reap provider runtime processes the OS still
    // holds but no session owns.
    //
    // Sibling of `sweepOrphanedTurns`, which settles orphaned *turn rows*: this
    // one settles orphaned *OS processes*. A detached `opencode serve` that
    // escaped its owning scope is reparented to init and keeps ~500 MB charged
    // to our cgroup until the whole service restarts; nothing else in the
    // system ever looks at the process table.
    //
    // Guard rails, in order of application (see `selectOrphanProviderProcesses`):
    // never our own PID or an ancestor of it, never a process outside our own
    // cgroup, never a command that is not a known provider runtime, never a PID
    // whose session binding is still live, and — for anything we did not spawn
    // ourselves — only once the kernel has reparented it to init.
    const sweepOrphanProcesses = Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (!supportsProcessTreeInspection(platform)) {
        return;
      }

      const cgroupPids = readOwnCgroupProcessIds();
      if (cgroupPids === null) {
        // Without proven cgroup membership we cannot honour the "only our own
        // processes" guard rail, so we do nothing at all.
        yield* Effect.logDebug("provider.session.reaper.orphan-process-scan-skipped", {
          reason: "cgroup_membership_unavailable",
        });
        return;
      }

      const entries = snapshotProcesses();
      const selfPid = process.pid;

      // Housekeeping: a runtime that exited on its own without its scope ever
      // closing leaves a record behind. Absent from /proc means provably gone,
      // so the registry cannot grow without bound over a long server run.
      const livePids = new Set(entries.map((entry) => entry.pid));
      const trackedRecords = listProviderRuntimeProcesses();
      for (const stale of trackedRecords.filter((entry) => !livePids.has(entry.pid))) {
        unregisterProviderRuntimeProcess(stale.pid);
      }

      const candidates = selectOrphanProviderProcesses({
        entries,
        cgroupPids,
        selfPid,
        ancestorPids: new Set(collectAncestorPids(selfPid, entries)),
        liveThreadIds: new Set(
          (yield* providerService.listSessions()).map((session) => String(session.threadId)),
        ),
        trackedRecords,
        nowMillis: yield* Clock.currentTimeMillis,
        trackedGraceMillis: TRACKED_ORPHAN_GRACE_MS,
      });

      for (const candidate of candidates) {
        const outcome = yield* terminateProcessTree({
          rootPid: candidate.pid,
          gracePeriodMillis: ORPHAN_PROCESS_GRACE_MS,
        });
        if (outcome.exited) {
          unregisterProviderRuntimeProcess(candidate.pid);
        }
        yield* increment(providerRuntimeOrphanProcessesKilledTotal, {
          provider: candidate.provider,
          reason: candidate.reason,
          outcome: outcome.exited ? (outcome.forced ? "forced" : "graceful") : "survived",
        });
        yield* Effect.logWarning("provider.session.reaper.orphan-process-killed", {
          pid: candidate.pid,
          provider: candidate.provider,
          command: candidate.command,
          rssKb: candidate.rssKb,
          reason: candidate.reason,
          exited: outcome.exited,
          forced: outcome.forced,
          survivingPids: outcome.survivingPids,
        });
      }
    }).pipe(
      // Fail-soft: a racing or unreadable /proc entry must never take the
      // periodic sweep down with it.
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.reaper.orphan-process-scan-failed", { cause }),
      ),
      Effect.catchDefect((defect: unknown) =>
        Effect.logWarning("provider.session.reaper.orphan-process-scan-defect", { defect }),
      ),
    );
    // T3-CUSTOM(expbkt3): END

    const sweep = Effect.gen(function* () {
      // T3-CUSTOM(expbkt3): every phase is timed. The sweep shares the event
      // loop with every client connection, so a slow phase is an outage, and
      // an outage that leaves no number in the journal is a mystery
      // (2026-09-03: unindexed event queries froze bkt3 for minutes per sweep).
      const sweepStartedMs = yield* Clock.currentTimeMillis;
      yield* sweepOrphanedTurns;
      const orphanedTurnsDoneMs = yield* Clock.currentTimeMillis;
      // T3-CUSTOM(expbkt3): OS orphan pass runs after the turn pass, so a
      // session settled above is already absent from the live bindings.
      yield* sweepOrphanProcesses;
      const orphanProcessesDoneMs = yield* Clock.currentTimeMillis;

      // T3-CUSTOM(expbkt3): decode only non-stopped bindings; the loop skips the rest.
      const bindings = yield* listLiveProviderBindings(directory).pipe(
        Effect.provide(reconcileContext),
      );
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        if (now - lastSeenMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        // Ingestion updates this timestamp alongside activeTurnId when a turn
        // settles. Long turns must get a full idle window after that transition,
        // even though the binding was last touched when the turn was sent.
        const lastActivityMs = Math.max(
          lastSeenMs,
          Date.parse(thread?.session?.updatedAt ?? binding.lastSeenAt),
        );
        const idleDurationMs = now - lastActivityMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // T3-CUSTOM(expbkt3): BEGIN - the projection's activeTurnId is not
        // proof of idleness: it can be cleared (by the orphaned-turn pass, or a
        // turn.started lost to the generation fence) while the agent streams,
        // and lastSeenAt only moves on runtime operations. If the adapter still
        // holds a turn AND the thread recorded an event inside the threshold,
        // the agent is alive - do not terminate it mid tool call (2026-08-20
        // 17:33:50, `mcp:1e019f68`). A held turn with no events past the
        // threshold is a session we have gone blind to; that one is reaped.
        const inspection = yield* providerService
          .inspectSession(binding.threadId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (inspection?.activeProviderTurnId != null) {
          const lastEventAt = yield* latestThreadEventAt(binding.threadId).pipe(
            Effect.provide(reconcileContext),
            Effect.catchCause(() => Effect.succeed(null)),
          );
          const lastEventMs = lastEventAt === null ? Number.NaN : Date.parse(lastEventAt);
          if (!Number.isNaN(lastEventMs) && now - lastEventMs < inactivityThresholdMs) {
            yield* Effect.logDebug("provider.session.reaper.skipped-live-provider-turn", {
              threadId: binding.threadId,
              activeProviderTurnId: inspection.activeProviderTurnId,
              idleDurationMs,
              lastEventAt,
            });
            continue;
          }
        }
        // T3-CUSTOM(expbkt3): END

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        // T3-CUSTOM(expbkt3): terminate (not stop) idle sessions so the process tree exits.
        const reaped = yield* providerService.terminateSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.termination-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      // T3-CUSTOM(expbkt3): logged on every sweep, not only when something
      // was reaped, so the phase durations are always in the journal.
      const sweepDoneMs = yield* Clock.currentTimeMillis;
      yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
        reapedCount,
        totalBindings: bindings.length,
        durationMs: sweepDoneMs - sweepStartedMs,
        orphanedTurnsMs: orphanedTurnsDoneMs - sweepStartedMs,
        orphanProcessesMs: orphanProcessesDoneMs - orphanedTurnsDoneMs,
        bindingsMs: sweepDoneMs - orphanProcessesDoneMs,
      });
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
