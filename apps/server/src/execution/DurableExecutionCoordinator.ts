// T3-CUSTOM(expbkt3): durable work-item claims, retry timing, and fenced dispatch.
import type { OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Metric from "effect/Metric";
import type * as Scope from "effect/Scope";

import {
  DurableExecutionIntentRepository,
  type DurableExecutionIntent,
} from "./DurableExecutionIntentRepository.ts";
import {
  durableExecutionAckToActiveDuration,
  durableExecutionFencingRejectionsTotal,
  durableExecutionLeaseRecoveriesTotal,
  durableExecutionRecoveryAttemptsTotal,
  increment,
  metricAttributes,
} from "../observability/Metrics.ts";

const RETRY_DELAYS_MS = [
  0, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000,
] as const;
const LEASE_MS = 60_000;
const LEASE_RENEW_MS = 15_000;
const MAX_GLOBAL_CONCURRENCY = 2;
/**
 * How long the claim loop idles after a failed wait before it looks again. Only
 * reached when the wait itself errored, so it trades one idle interval for the
 * guarantee that a transient read failure never costs more than that interval.
 */
const WAKE_RETRY_INTERVAL_MS = 5_000;
/** Backstop pause before relaunching a claim loop that terminated unexpectedly. */
const LOOP_RESTART_DELAY_MS = 1_000;
/**
 * Upper bound on any idle wait. Wakes arrive through the provider command
 * reactor's single worker lane; when that lane stalled (2026-08-20: a provider
 * stop that never returned) this loop sat in `Queue.take` for over an hour with
 * runnable rows in the table. A lost wake now costs one poll, not an outage.
 */
export const DEFAULT_SAFETY_POLL_INTERVAL_MS = 10_000;

export function shouldPublishRecoveryActivity(
  kind: "started" | "recovered" | "paused" | "exhausted",
  attempt: number,
): boolean {
  return kind !== "started" || attempt === 1;
}

export function durableExecutionRetryDelayMs(workItemId: string, attempt: number): number | null {
  const base = RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return null;
  if (base === 0) return 0;
  let hash = 2_166_136_261;
  for (const character of `${workItemId}:${attempt}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  const unit = (hash >>> 0) / 0xffff_ffff;
  return Math.max(1, Math.round(base * (0.9 + unit * 0.2)));
}

function addMillis(iso: string, millis: number): string {
  return DateTime.formatIso(
    DateTime.addDuration(DateTime.makeUnsafe(iso), Duration.millis(millis)),
  );
}

function millisUntil(now: string, target: string): number {
  return Math.max(
    1,
    DateTime.toEpochMillis(DateTime.makeUnsafe(target)) -
      DateTime.toEpochMillis(DateTime.makeUnsafe(now)),
  );
}

export class DurableExecutionDispatchError extends Schema.TaggedError<DurableExecutionDispatchError>()(
  "DurableExecutionDispatchError",
  {
    failureType: Schema.String,
    detail: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface DurableExecutionDispatchResult {
  readonly providerTurnId: string | null;
  readonly providerInstanceId: string | null;
  readonly adoptedExecutionId?: string;
  /** The provider turn was associated with this accepted same-turn steer. */
  readonly associationAcknowledged?: boolean;
  /**
   * The provider accepted a same-turn steer, but persisting its visible
   * association failed. The coordinator records this before releasing the
   * claim so a retry can deliver only the association command.
   */
  readonly associationPending?: {
    readonly providerTurnId: string;
    readonly providerInstanceId: string | null;
    readonly adoptedExecutionId: string;
  };
  readonly deferred?: boolean;
  readonly completed?: boolean;
  /** A native prompt command completed without creating a provider turn. */
  readonly handledCommand?: boolean;
}

type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

export interface DurableExecutionCoordinatorOptions {
  readonly ownerId: string;
  readonly now?: () => Effect.Effect<string>;
  /** Override of {@link DEFAULT_SAFETY_POLL_INTERVAL_MS}; tests use a short one. */
  readonly safetyPollIntervalMs?: number;
  readonly loadEvent: (
    intent: DurableExecutionIntent,
  ) => Effect.Effect<TurnStartEvent, DurableExecutionDispatchError>;
  readonly prepare?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly event: TurnStartEvent;
    readonly owner: string;
    readonly generation: number;
  }) => Effect.Effect<void, DurableExecutionDispatchError>;
  readonly dispatchOriginal: (input: {
    readonly intent: DurableExecutionIntent;
    readonly event: TurnStartEvent;
  }) => Effect.Effect<DurableExecutionDispatchResult, DurableExecutionDispatchError, Scope.Scope>;
  readonly recover: (input: {
    readonly intent: DurableExecutionIntent;
    readonly event: TurnStartEvent;
    readonly mode: "exact-undelivered" | "inspect-or-continue";
  }) => Effect.Effect<DurableExecutionDispatchResult, DurableExecutionDispatchError, Scope.Scope>;
  /** T3-CUSTOM(expbkt3): publish desired-state transitions to connected clients. */
  readonly onTransition?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly workItemId: string;
    readonly threadId: DurableExecutionIntent["threadId"];
  }) => Effect.Effect<void>;
  readonly onRecoveryActivity?: (input: {
    readonly intent: DurableExecutionIntent;
    readonly kind: "started" | "recovered" | "paused" | "exhausted";
    readonly attempt: number;
    readonly detail?: string;
  }) => Effect.Effect<void>;
  readonly terminateObserved?: (intent: DurableExecutionIntent) => Effect.Effect<void>;
}

export interface DurableExecutionCoordinatorShape {
  readonly run: (workItemId: string) => Effect.Effect<void>;
  readonly wake: (workItemId: string) => Effect.Effect<void>;
  readonly runDue: Effect.Effect<void>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export const makeDurableExecutionCoordinator = Effect.fn("makeDurableExecutionCoordinator")(
  function* (options: DurableExecutionCoordinatorOptions) {
    const repository = yield* DurableExecutionIntentRepository;
    const globalConcurrency = yield* Semaphore.make(MAX_GLOBAL_CONCURRENCY);
    const wakeQueue = yield* Queue.unbounded<string>();
    // T3-CUSTOM(expbkt3): the scheduler must keep consuming wakes while an
    // individual preparation waits for a setup command. Track only admitted
    // workers, rather than forking an unbounded set of fibers that wait on the
    // semaphore themselves.
    const trackedWorkItems = yield* Ref.make(new Set<string>());
    const now = options.now ?? (() => Effect.map(DateTime.now, DateTime.formatIso));
    const safetyPollIntervalMs = options.safetyPollIntervalMs ?? DEFAULT_SAFETY_POLL_INTERVAL_MS;
    const notifyTransition = (intent: DurableExecutionIntent) =>
      options.onTransition?.({
        intent,
        workItemId: intent.workItemId,
        threadId: intent.threadId,
      }) ?? Effect.void;

    const runClaimed = Effect.fn("DurableExecutionCoordinator.runClaimed")(function* (
      claimed: DurableExecutionIntent,
    ) {
      return yield* Effect.gen(function* () {
        // A pending same-turn association is stored in retry-wait and claim()
        // normalizes that phase to recovering. It has already delivered the
        // provider input, so keep it on the original dispatch path where the
        // reactor retries only the association command.
        const recovery =
          claimed.phase === "recovering" && claimed.lastFailureType !== "turn-association-pending";
        const activeIntent = recovery
          ? yield* repository.beginRecoveryAttempt({
              workItemId: claimed.workItemId,
              owner: options.ownerId,
              generation: claimed.claimGeneration,
              at: yield* now(),
            })
          : Option.some(claimed);
        if (Option.isNone(activeIntent)) return;
        const intent = activeIntent.value;
        if (
          recovery &&
          options.onRecoveryActivity &&
          shouldPublishRecoveryActivity("started", intent.recoveryAttempts)
        ) {
          yield* options.onRecoveryActivity({
            intent,
            kind: "started",
            attempt: intent.recoveryAttempts,
          });
        }
        if (recovery) {
          yield* increment(durableExecutionRecoveryAttemptsTotal, {
            providerInstanceId: intent.providerInstanceId ?? "unknown",
            reason: intent.lastFailureType ?? "unknown",
            outcome: "started",
            attempt: intent.recoveryAttempts,
          });
        }

        const claimStillCurrent = yield* repository.isClaimCurrent({
          workItemId: intent.workItemId,
          owner: options.ownerId,
          generation: intent.claimGeneration,
          now: yield* now(),
        });
        if (!claimStillCurrent) {
          yield* increment(durableExecutionFencingRejectionsTotal, {
            threadId: intent.threadId,
            workItemId: intent.workItemId,
            generation: intent.claimGeneration,
            boundary: "before-load",
          });
          return;
        }

        const renewLease = Effect.gen(function* () {
          const at = yield* now();
          const renewed = yield* repository.renewClaim({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            expiresAt: addMillis(at, LEASE_MS),
            at,
          });
          if (!renewed) return yield* Effect.interrupt;
        }).pipe(Effect.repeat(Schedule.spaced(Duration.millis(LEASE_RENEW_MS))));

        const dispatch = Effect.gen(function* () {
          yield* Effect.forkScoped(renewLease);
          const event = yield* options.loadEvent(intent);
          const beforeSideEffect = yield* now();
          if (
            !(yield* repository.isClaimCurrent({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              now: beforeSideEffect,
            }))
          ) {
            yield* increment(durableExecutionFencingRejectionsTotal, {
              threadId: intent.threadId,
              workItemId: intent.workItemId,
              generation: intent.claimGeneration,
              boundary: "before-provider-side-effect",
            });
            return;
          }
          if (options.prepare) {
            yield* options.prepare({
              intent,
              event,
              owner: options.ownerId,
              generation: intent.claimGeneration,
            });
          }
          const afterPreparation = yield* now();
          if (
            !(yield* repository.isClaimCurrent({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              now: afterPreparation,
            }))
          ) {
            yield* increment(durableExecutionFencingRejectionsTotal, {
              threadId: intent.threadId,
              workItemId: intent.workItemId,
              generation: intent.claimGeneration,
              boundary: "after-preparation",
            });
            return;
          }
          // Persist the provider side-effect boundary. If this authority dies
          // after delivery but before acknowledgement, startup recovery must
          // inspect/adopt instead of replaying the original prompt.
          if (
            !(yield* repository.markProviderStarting({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              at: afterPreparation,
            }))
          ) {
            yield* increment(durableExecutionFencingRejectionsTotal, {
              threadId: intent.threadId,
              workItemId: intent.workItemId,
              generation: intent.claimGeneration,
              boundary: "provider-starting",
            });
            return;
          }
          const result = recovery
            ? yield* options.recover({
                intent,
                event,
                mode:
                  intent.deliveryCertainty === "never-delivered"
                    ? "exact-undelivered"
                    : "inspect-or-continue",
              })
            : yield* options.dispatchOriginal({ intent, event });
          if (result.deferred === true) {
            yield* repository.deferClaim({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              at: yield* now(),
              restoreRecoveryAttempt: recovery,
            });
            return;
          }
          if (result.associationPending !== undefined) {
            yield* repository.markAssociationPending({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              providerTurnId: result.associationPending.providerTurnId,
              providerInstanceId: result.associationPending.providerInstanceId,
              adoptedExecutionId: result.associationPending.adoptedExecutionId,
              at: yield* now(),
            });
            return;
          }
          if (
            result.completed === true &&
            (result.providerTurnId !== null || result.handledCommand === true)
          ) {
            const reconciled = yield* repository.markCompletedFromHistory({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              providerTurnId: result.providerTurnId,
              providerInstanceId: result.providerInstanceId,
              completionKind:
                result.handledCommand === true ? "handled-command" : "history-completed",
              at: yield* now(),
            });
            if (reconciled && recovery && options.onRecoveryActivity) {
              yield* options.onRecoveryActivity({
                intent,
                kind: "recovered",
                attempt: intent.recoveryAttempts,
              });
            }
            if (reconciled && recovery) {
              yield* increment(durableExecutionRecoveryAttemptsTotal, {
                providerInstanceId: result.providerInstanceId ?? "unknown",
                reason: intent.lastFailureType ?? "unknown",
                outcome: "history-completed",
                attempt: intent.recoveryAttempts,
              });
            }
            return;
          }
          if (result.providerTurnId === null) {
            return yield* new DurableExecutionDispatchError({
              failureType: "provider-turn-not-acknowledged",
              detail: "Provider dispatch returned no matching turn evidence.",
              retryable: true,
            });
          }
          const acknowledged = yield* repository.markAcknowledged({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            providerTurnId: result.providerTurnId,
            providerInstanceId: result.providerInstanceId,
            adoptedExecutionId: result.adoptedExecutionId ?? intent.workItemId,
            terminalAssociation: result.associationAcknowledged === true,
            at: yield* now(),
          });
          if (acknowledged && recovery && options.onRecoveryActivity) {
            yield* options.onRecoveryActivity({
              intent,
              kind: "recovered",
              attempt: intent.recoveryAttempts,
            });
          }
          if (acknowledged) {
            yield* Metric.update(
              Metric.withAttributes(
                durableExecutionAckToActiveDuration,
                metricAttributes({
                  providerInstanceId: result.providerInstanceId ?? "unknown",
                  recovery,
                }),
              ),
              Duration.millis(
                Math.max(
                  0,
                  DateTime.toEpochMillis(DateTime.makeUnsafe(yield* now())) -
                    DateTime.toEpochMillis(DateTime.makeUnsafe(intent.acceptedAt)),
                ),
              ),
            );
            if (recovery) {
              yield* increment(durableExecutionRecoveryAttemptsTotal, {
                providerInstanceId: result.providerInstanceId ?? "unknown",
                reason: intent.lastFailureType ?? "unknown",
                outcome: "recovered",
                attempt: intent.recoveryAttempts,
              });
            }
          }
        });

        yield* notifyTransition(intent);
        const exit = yield* Effect.exit(Effect.scoped(dispatch));
        if (Exit.isSuccess(exit)) return;
        const error = Cause.squash(exit.cause);
        const dispatchError = Schema.is(DurableExecutionDispatchError)(error)
          ? error
          : new DurableExecutionDispatchError({
              failureType: "unexpected-dispatch-failure",
              detail: Cause.pretty(exit.cause),
              retryable: true,
              cause: error,
            });
        const failedAt = yield* now();
        if (!dispatchError.retryable) {
          // T3-CUSTOM(expbkt3): input validation before worktree creation is
          // safe to retry after the user corrects it. Keep genuine creation
          // uncertainty intact so Retry cannot duplicate a worktree.
          if (
            dispatchError.failureType.startsWith("bootstrap-worktree-") &&
            dispatchError.failureType !== "bootstrap-worktree-uncertain"
          ) {
            yield* repository.markBootstrapStepFailed({
              workItemId: intent.workItemId,
              owner: options.ownerId,
              generation: intent.claimGeneration,
              step: "worktree",
              phase: "failed",
              detail: dispatchError.detail,
              at: failedAt,
            });
          }
          const paused = yield* repository.markFailedAttention({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            failureType: dispatchError.failureType,
            detail: dispatchError.detail,
            at: failedAt,
          });
          if (paused && options.onRecoveryActivity) {
            yield* options.onRecoveryActivity({
              intent,
              kind: "paused",
              attempt: intent.recoveryAttempts,
              detail: dispatchError.detail,
            });
          }
          if (paused && recovery) {
            yield* increment(durableExecutionRecoveryAttemptsTotal, {
              providerInstanceId: intent.providerInstanceId ?? "unknown",
              reason: dispatchError.failureType,
              outcome: "paused",
              attempt: intent.recoveryAttempts,
            });
          }
          return;
        }
        if (!recovery) {
          const recorded = yield* repository.markOriginalDispatchFailed({
            workItemId: intent.workItemId,
            owner: options.ownerId,
            generation: intent.claimGeneration,
            failureType: dispatchError.failureType,
            detail: dispatchError.detail,
            deliveryUncertain: !dispatchError.failureType.startsWith("bootstrap-"),
            at: failedAt,
          });
          if (recorded) yield* Queue.offer(wakeQueue, intent.workItemId);
          return;
        }
        const nextDelay = durableExecutionRetryDelayMs(
          intent.workItemId,
          intent.recoveryAttempts + 1,
        );
        if (nextDelay === null && options.terminateObserved) {
          yield* options.terminateObserved(intent).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to terminate provider while exhausting recovery", {
                threadId: intent.threadId,
                workItemId: intent.workItemId,
                generation: intent.claimGeneration,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        }
        const recorded = yield* repository.markRecoveryAttemptFailed({
          workItemId: intent.workItemId,
          owner: options.ownerId,
          generation: intent.claimGeneration,
          failureType: dispatchError.failureType,
          detail: dispatchError.detail,
          nextAttemptAt: nextDelay === null ? null : addMillis(failedAt, nextDelay),
          at: failedAt,
        });
        if (recorded && nextDelay === null && options.onRecoveryActivity) {
          yield* options.onRecoveryActivity({
            intent,
            kind: "exhausted",
            attempt: intent.recoveryAttempts,
            detail: dispatchError.detail,
          });
        }
        if (recorded) {
          yield* increment(durableExecutionRecoveryAttemptsTotal, {
            providerInstanceId: intent.providerInstanceId ?? "unknown",
            reason: dispatchError.failureType,
            outcome: nextDelay === null ? "exhausted" : "failed",
            attempt: intent.recoveryAttempts,
          });
        }
      }).pipe(
        Effect.ensuring(
          notifyTransition(claimed).pipe(Effect.andThen(Queue.offer(wakeQueue, "")), Effect.asVoid),
        ),
      );
    });

    const run: DurableExecutionCoordinatorShape["run"] = (workItemId) =>
      globalConcurrency
        .withPermits(1)(
          Effect.gen(function* () {
            const at = yield* now();
            const claimed = yield* repository.claim({
              workItemId,
              owner: options.ownerId,
              now: at,
              expiresAt: addMillis(at, LEASE_MS),
            });
            if (Option.isSome(claimed)) {
              yield* notifyTransition(claimed.value);
              yield* runClaimed(claimed.value);
            }
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError("durable execution coordinator run failed", {
              workItemId,
              owner: options.ownerId,
              cause: Cause.pretty(cause),
            }),
          ),
        );

    const launch = Effect.fn("DurableExecutionCoordinator.launch")(function* (workItemId: string) {
      const admitted = yield* Ref.modify(trackedWorkItems, (tracked) => {
        if (tracked.has(workItemId) || tracked.size >= MAX_GLOBAL_CONCURRENCY) {
          return [false, tracked] as const;
        }
        const next = new Set(tracked);
        next.add(workItemId);
        return [true, next] as const;
      });
      if (!admitted) return;
      yield* Effect.forkScoped(
        run(workItemId).pipe(
          Effect.ensuring(
            Ref.update(trackedWorkItems, (tracked) => {
              const next = new Set(tracked);
              next.delete(workItemId);
              return next;
            }).pipe(Effect.andThen(Queue.offer(wakeQueue, "")), Effect.asVoid),
          ),
        ),
      );
    });

    const launchDue = Effect.gen(function* () {
      if ((yield* Ref.get(trackedWorkItems)).size >= MAX_GLOBAL_CONCURRENCY) return;
      const due = yield* repository.listRunnable({
        now: yield* now(),
        limit: MAX_GLOBAL_CONCURRENCY,
      });
      yield* Effect.forEach(due, (intent) => launch(intent.workItemId), { discard: true });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable execution coordinator due scan failed", {
          owner: options.ownerId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    // Keep the public one-shot drain deterministic for callers and focused
    // tests. The long-lived scheduler below uses launchDue so no in-flight
    // setup can stall wake processing.
    const runDue: DurableExecutionCoordinatorShape["runDue"] = Effect.gen(function* () {
      const due = yield* repository.listRunnable({ now: yield* now(), limit: 100 });
      yield* Effect.forEach(due, (intent) => run(intent.workItemId), {
        concurrency: MAX_GLOBAL_CONCURRENCY,
        discard: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("durable execution coordinator due scan failed", {
          owner: options.ownerId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const waitForWakeOrDue = Effect.gen(function* () {
      // T3-CUSTOM(expbkt3): a due row remains due while both bounded workers
      // are occupied. Worker release wakes this queue, avoiding a tight scan.
      if ((yield* Ref.get(trackedWorkItems)).size >= MAX_GLOBAL_CONCURRENCY) {
        return yield* Effect.race(
          Queue.take(wakeQueue),
          Effect.sleep(Duration.millis(safetyPollIntervalMs)).pipe(Effect.as("")),
        );
      }
      const at = yield* now();
      const next = yield* repository.nextRunnableAt({ now: at });
      if (Option.isSome(next) && next.value <= at) return "";
      const waitMs = Option.isNone(next)
        ? safetyPollIntervalMs
        : Math.min(safetyPollIntervalMs, millisUntil(at, next.value));
      return yield* Effect.race(
        Queue.take(wakeQueue),
        Effect.sleep(Duration.millis(waitMs)).pipe(Effect.as("")),
      );
    }).pipe(
      // `runDue` and `run` were already guarded; this wait was the one step in
      // the loop that could fail it, and `nextRunnableAt` fails with a
      // persistence error. An unguarded failure here terminates the only fiber
      // that ever moves a work item out of `queued` — for the whole process,
      // for every thread and every user, with no retry and nothing to observe
      // but silence. Degrade to an idle interval instead of losing the queue.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logError("durable execution coordinator wait failed", {
              owner: options.ownerId,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                Effect.race(
                  Queue.take(wakeQueue),
                  Effect.sleep(Duration.millis(WAKE_RETRY_INTERVAL_MS)).pipe(Effect.as("")),
                ),
              ),
            ),
      ),
    );

    const loop = Effect.forever(
      launchDue.pipe(
        Effect.andThen(waitForWakeOrDue),
        Effect.flatMap((workItemId) =>
          workItemId.length === 0 ? Effect.void : launch(workItemId),
        ),
      ),
    );

    // Belt and braces for the same failure mode: whatever still manages to end
    // the loop — a defect, an unforeseen error channel added later — must cost
    // an interval and a log line, never the process's ability to start turns.
    // Interruption is scope teardown and stays terminal.
    const supervisedLoop = Effect.forever(
      loop.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError("durable execution coordinator loop stopped; restarting", {
                owner: options.ownerId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.andThen(Effect.sleep(Duration.millis(LOOP_RESTART_DELAY_MS)))),
        ),
      ),
    );

    const start: DurableExecutionCoordinatorShape["start"] = Effect.fn(
      "DurableExecutionCoordinator.start",
    )(function* () {
      const reconcileStartedAt = yield* Clock.currentTimeMillis;
      const recoveredLeases = yield* repository.reconcileStartup({ at: yield* now() }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("durable execution startup reconciliation failed", {
            owner: options.ownerId,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(0)),
        ),
      );
      yield* Effect.logInfo("durable execution startup reconciliation finished", {
        owner: options.ownerId,
        recoveredLeases,
        durationMs: (yield* Clock.currentTimeMillis) - reconcileStartedAt,
      });
      if (recoveredLeases > 0) {
        yield* increment(
          durableExecutionLeaseRecoveriesTotal,
          { authorityEpoch: options.ownerId },
          recoveredLeases,
        );
      }
      yield* Effect.forkScoped(supervisedLoop);
      yield* Queue.offer(wakeQueue, "");
    });

    return {
      run,
      wake: (workItemId) => Queue.offer(wakeQueue, workItemId).pipe(Effect.asVoid),
      runDue,
      start,
    } satisfies DurableExecutionCoordinatorShape;
  },
);
