import {
  MessageId,
  ThreadId,
  ThreadTurnAdmissionConflictError,
  TurnId,
  type OrchestrationStopExecutionResult,
  type ProviderRuntimeEvent,
  type ThreadExecutionSnapshot,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  increment,
  setMetric,
  threadExecutionsActive,
  threadExecutionGenerationRejectionsTotal,
  threadExecutionInvariantRepairsTotal,
  threadExecutionStopDuration,
  threadExecutionStopAcknowledgementDuration,
  threadExecutionStopEscalationsTotal,
  threadExecutionTerminationOutcomesTotal,
  threadExecutionTransitionsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
// T3-CUSTOM(expbkt3): session recovery desired-state.
import {
  SessionRecoveryStateRepository,
  type SessionRecoveryStateRepositoryError,
} from "../persistence/SessionRecoveryState.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
// T3-CUSTOM(expbkt3): direct WebSocket Stop must cancel its setup child too.
import { TerminalManager } from "../terminal/Manager.ts";
// T3-CUSTOM(expbkt3): user Stop fences durable recovery before provider side effects.
import { DurableExecutionIntentRepository } from "./DurableExecutionIntentRepository.ts";
import {
  ThreadExecutionSupervisor,
  type ThreadExecutionSupervisorShape,
} from "./ThreadExecutionSupervisor.ts";

interface ExecutionRow {
  readonly threadId: string;
  readonly authorityEpoch: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly activity: ThreadExecutionSnapshot["activity"];
  readonly canStop: number;
  readonly providerSessionState: ThreadExecutionSnapshot["providerSession"]["state"];
  readonly providerGeneration: number;
  readonly providerInstanceId: string | null;
  readonly providerStartedAt: string | null;
  readonly providerLastObservedAt: string | null;
  readonly providerLastError: string | null;
  readonly executionId: string | null;
  readonly providerTurnId: string | null;
  readonly turnState: NonNullable<ThreadExecutionSnapshot["turn"]>["state"] | null;
  readonly turnStartedAt: string | null;
  readonly stopRequestedAt: string | null;
  readonly turnCompletedAt: string | null;
  readonly turnLastError: string | null;
}

// T3-CUSTOM(expbkt3): minimal read model joined into public execution snapshots.
interface ExecutionIntentSnapshotRow {
  readonly workItemId: string;
  readonly messageId: string;
  readonly desiredState: "running" | "stopped";
  readonly phase: NonNullable<ThreadExecutionSnapshot["intent"]>["phase"];
  readonly recoveryAttempts: number;
  readonly maximumRecoveryAttempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastFailureType: string | null;
  readonly lastFailureDetail: string | null;
  readonly acceptedAt: string;
  readonly updatedAt: string;
  readonly bootstrapJson: string | null;
  readonly worktreePhase:
    | "pending"
    | "running"
    | "acknowledged"
    | "failed"
    | "uncertain"
    | "not-required"
    | null;
  readonly setupPhase:
    | "pending"
    | "running"
    | "acknowledged"
    | "failed"
    | "uncertain"
    | "not-required"
    | null;
  readonly setupTerminalId: string | null;
}

interface PersistedBlockerRow {
  readonly kind: "approval.requested" | "user-input.requested";
}

interface PersistedResolutionRow {
  readonly requestId: string;
}

type ExecutionIntentBootstrapSnapshot = NonNullable<
  NonNullable<ThreadExecutionSnapshot["intent"]>["bootstrap"]
>;

function bootstrapSnapshotFromRow(
  row: ExecutionIntentSnapshotRow,
): ExecutionIntentBootstrapSnapshot | undefined {
  if (row.bootstrapJson === null || row.worktreePhase === null || row.setupPhase === null)
    return undefined;
  try {
    const bootstrap = JSON.parse(row.bootstrapJson) as {
      readonly resolvedRequest?: {
        readonly workspace?: {
          readonly mode?: "local" | "existing-worktree" | "new-worktree";
          readonly path?: string;
          readonly intendedPath?: string;
          readonly newBranch?: string;
          readonly baseRef?: {
            readonly kind?: string;
            readonly source?: string;
            readonly branch?: string;
          };
        };
      };
    };
    const workspace = bootstrap.resolvedRequest?.workspace;
    if (workspace?.mode === undefined) return undefined;
    const baseRef = workspace.baseRef;
    const base =
      baseRef?.kind === "branch" && baseRef.source && baseRef.branch
        ? `${baseRef.source}/${baseRef.branch}`
        : baseRef?.kind === "repository-default" && baseRef.source
          ? `${baseRef.source} default`
          : null;
    return {
      workspaceMode: workspace.mode,
      base,
      intendedPath: workspace.intendedPath ?? workspace.path ?? null,
      newBranch: workspace.newBranch ?? null,
      worktreePhase: row.worktreePhase,
      setupPhase: row.setupPhase,
      failureDetail: row.lastFailureDetail,
      setupTerminalId: row.setupTerminalId,
    };
  } catch {
    return undefined;
  }
}

const isActiveActivity = (activity: ThreadExecutionSnapshot["activity"]) =>
  activity === "active" || activity === "blocked" || activity === "stopping";

const inspectionProviderState = (
  state: "starting" | "ready" | "running" | "stopping" | "stopped" | "failed",
): ThreadExecutionSnapshot["providerSession"]["state"] => (state === "running" ? "ready" : state);

const isTerminalTurn = (snapshot: ThreadExecutionSnapshot) =>
  snapshot.turn === null ||
  snapshot.turn.state === "completed" ||
  snapshot.turn.state === "interrupted" ||
  snapshot.turn.state === "failed";

const rowToSnapshot = (row: ExecutionRow): ThreadExecutionSnapshot => ({
  threadId: ThreadId.make(row.threadId),
  authorityEpoch: row.authorityEpoch,
  revision: row.revision,
  observedAt: row.observedAt,
  activity: row.activity,
  canStop: row.canStop !== 0,
  providerSession: {
    state: row.providerSessionState,
    generation: row.providerGeneration,
    providerInstanceId: row.providerInstanceId === null ? null : (row.providerInstanceId as never),
    startedAt: row.providerStartedAt,
    lastObservedAt: row.providerLastObservedAt,
    lastError: row.providerLastError,
  },
  turn:
    row.executionId === null || row.turnState === null || row.turnStartedAt === null
      ? null
      : {
          executionId: row.executionId,
          providerTurnId: row.providerTurnId === null ? null : TurnId.make(row.providerTurnId),
          state: row.turnState,
          startedAt: row.turnStartedAt,
          stopRequestedAt: row.stopRequestedAt,
          completedAt: row.turnCompletedAt,
          lastError: row.turnLastError,
        },
});

const make = Effect.fn("ThreadExecutionSupervisor.make")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const provider = yield* ProviderService;
  const orchestration = yield* OrchestrationEngineService;
  // T3-CUSTOM(expbkt3): desired-state journal for automatic session recovery.
  const recoveryState = yield* SessionRecoveryStateRepository;
  // T3-CUSTOM(expbkt3): optional keeps isolated/upstream supervisor layers compatible.
  const durableIntentRepository = yield* Effect.serviceOption(DurableExecutionIntentRepository);
  const terminalManager = yield* Effect.serviceOption(TerminalManager);
  const authorityEpoch = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
  const state = new Map<ThreadId, ThreadExecutionSnapshot>();
  const stopOperations = new Map<string, string>();
  const completedStopOperations = new Map<string, OrchestrationStopExecutionResult>();
  const stopLocks = new Map<ThreadId, Semaphore.Semaphore>();
  const transitions = yield* Semaphore.make(1);
  const snapshots = yield* PubSub.unbounded<ThreadExecutionSnapshot>();
  const observedGaugeKeys = new Set<string>();
  const terminalWaiters = new Map<string, Set<Deferred.Deferred<ThreadExecutionSnapshot>>>();
  // T3-CUSTOM(expbkt3): provider resolutions are per request. A second native
  // prompt must keep the snapshot blocked after the first answer arrives.
  const blockingRequestIds = new Map<ThreadId, Set<string>>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // T3-CUSTOM(expbkt3): desired state and provider observation travel together.
  // One set of queries covers any number of threads: a shell snapshot of ~200
  // threads used to run 3 statements per thread on the single sqlite
  // connection (~600 statements, >1 s cold in prod) for every HTTP shell read
  // and shell resume.
  const mergeCurrentIntent = (
    snapshot: ThreadExecutionSnapshot,
    row: ExecutionIntentSnapshotRow | undefined,
    blockers: ReadonlyArray<{ readonly kind: string }>,
    resolutions: ReadonlyArray<{ readonly requestId: string }>,
  ): ThreadExecutionSnapshot => {
    const hasPersistedApprovalBlocker = blockers.some(
      (blocker) => blocker.kind === "approval.requested",
    );
    // The map protects events that arrive before their activity projection;
    // it is never trusted after a restart, where the SQL ledger above wins.
    const inMemoryBlockers = blockingRequestIds.get(snapshot.threadId);
    if (inMemoryBlockers !== undefined) {
      for (const resolution of resolutions) inMemoryBlockers.delete(resolution.requestId);
      if (inMemoryBlockers.size === 0) blockingRequestIds.delete(snapshot.threadId);
    }
    const hasInMemoryBlocker = (blockingRequestIds.get(snapshot.threadId)?.size ?? 0) > 0;
    const hasBlocker = blockers.length > 0 || hasInMemoryBlocker;
    const hasApprovalBlocker =
      hasPersistedApprovalBlocker ||
      (blockers.length === 0 &&
        hasInMemoryBlocker &&
        snapshot.turn?.state === "waiting-for-approval");
    const canReconcileTurn =
      snapshot.turn !== null &&
      !isTerminalTurn(snapshot) &&
      snapshot.activity !== "stopping" &&
      snapshot.turn.state !== "stopping";
    const repairedSnapshot =
      hasBlocker && canReconcileTurn
        ? {
            ...snapshot,
            activity: "blocked" as const,
            turn: {
              ...snapshot.turn,
              state: hasApprovalBlocker
                ? ("waiting-for-approval" as const)
                : ("waiting-for-input" as const),
            },
          }
        : !hasBlocker &&
            canReconcileTurn &&
            snapshot.activity === "blocked" &&
            (snapshot.turn?.state === "waiting-for-approval" ||
              snapshot.turn?.state === "waiting-for-input")
          ? {
              ...snapshot,
              activity: "active" as const,
              turn: { ...snapshot.turn, state: "running" as const },
            }
          : snapshot;
    const { intent: _staleIntent, ...withoutIntent } = repairedSnapshot;
    if (row === undefined) return withoutIntent;
    const bootstrap = bootstrapSnapshotFromRow(row);
    return {
      ...withoutIntent,
      intent: {
        workItemId: row.workItemId,
        messageId: MessageId.make(row.messageId),
        desiredState: row.desiredState,
        phase: row.phase,
        acceptedAt: row.acceptedAt,
        updatedAt: row.updatedAt,
        ...(bootstrap === undefined ? {} : { bootstrap }),
        recovery: {
          attempt: row.recoveryAttempts,
          maximumAttempts: row.maximumRecoveryAttempts,
          nextAttemptAt: row.nextAttemptAt,
          reason: row.lastFailureDetail ?? row.lastFailureType,
          userActionRequired: row.phase === "recovery-exhausted",
        },
      },
    } satisfies ThreadExecutionSnapshot;
  };

  const withCurrentIntents = (
    snapshots: ReadonlyArray<ThreadExecutionSnapshot>,
  ): Effect.Effect<ReadonlyArray<ThreadExecutionSnapshot>> => {
    if (snapshots.length === 0) return Effect.succeed([]);
    const threadIds = JSON.stringify(snapshots.map((snapshot) => snapshot.threadId));
    return Effect.all([
      sql<ExecutionIntentSnapshotRow & { readonly threadId: string }>`
      SELECT * FROM (
        SELECT intent.thread_id AS "threadId",
             intent.work_item_id AS "workItemId", intent.message_id AS "messageId",
             intent.desired_state AS "desiredState", intent.phase,
             intent.recovery_attempts AS "recoveryAttempts",
             intent.maximum_recovery_attempts AS "maximumRecoveryAttempts",
             intent.next_attempt_at AS "nextAttemptAt",
             intent.last_failure_type AS "lastFailureType",
             intent.last_failure_detail AS "lastFailureDetail",
             intent.accepted_at AS "acceptedAt", intent.updated_at AS "updatedAt",
             intent.bootstrap_json AS "bootstrapJson",
             bootstrap.worktree_phase AS "worktreePhase",
             bootstrap.setup_phase AS "setupPhase",
             bootstrap.setup_terminal_id AS "setupTerminalId",
             ROW_NUMBER() OVER (
               PARTITION BY intent.thread_id
               ORDER BY CASE WHEN intent.desired_state = 'running' THEN 0 ELSE 1 END,
                        intent.request_event_sequence DESC, intent.accepted_at DESC
             ) AS "intentOrder"
        FROM projection_thread_execution_intents AS intent
        LEFT JOIN thread_execution_bootstrap_operations AS bootstrap
          ON bootstrap.work_item_id = intent.work_item_id
        WHERE intent.thread_id IN (SELECT value FROM json_each(${threadIds}))
          AND intent.dismissed_at IS NULL
          AND (intent.desired_state = 'running' OR intent.phase = 'recovery-exhausted')
      ) WHERE "intentOrder" = 1
      `,
      // T3-CUSTOM(expbkt3): The durable activity ledger, rather than the
      // newest queued intent or this process's event history, owns blocking.
      // This makes reconnects and simultaneous native requests deterministic.
      sql<PersistedBlockerRow & { readonly threadId: string; readonly turnId: string | null }>`
        WITH unresolved AS (
          SELECT requested.thread_id, requested.kind, requested.turn_id
          FROM projection_thread_activities AS requested
          WHERE requested.thread_id IN (SELECT value FROM json_each(${threadIds}))
            AND requested.kind IN ('approval.requested', 'user-input.requested')
            AND json_extract(requested.payload_json, '$.requestId') IS NOT NULL
            AND COALESCE(json_extract(requested.payload_json, '$.responseMode'), '') <> 'message'
            AND NOT EXISTS (
              SELECT 1 FROM projection_thread_activities AS resolved
              WHERE resolved.thread_id = requested.thread_id
                -- T3-CUSTOM(expbkt3): restrict the indexed kinds before reading activity JSON.
                AND resolved.kind IN ('approval.resolved', 'user-input.resolved', 'provider.user-input.respond.failed')
                AND json_extract(resolved.payload_json, '$.requestId') = json_extract(requested.payload_json, '$.requestId')
                AND (
                  resolved.kind IN ('approval.resolved', 'user-input.resolved')
                  OR (
                    resolved.kind = 'provider.user-input.respond.failed'
                    AND (
                      lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%stale pending user-input request%'
                      OR lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%unknown pending user-input request%'
                      OR lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%unknown pending user input request%'
                      OR lower(COALESCE(json_extract(resolved.payload_json, '$.detail'), '')) LIKE '%unknown pending codex user input request%'
                    )
                  )
                )
                AND (
                  COALESCE(resolved.sequence, -1) > COALESCE(requested.sequence, -1)
                  OR (COALESCE(resolved.sequence, -1) = COALESCE(requested.sequence, -1)
                    AND (resolved.created_at > requested.created_at OR (resolved.created_at = requested.created_at AND resolved.activity_id > requested.activity_id)))
                )
            )
            AND (
              requested.turn_id IS NULL
              -- The per-thread provider turn match is applied in JS below.
              OR NOT EXISTS (
                SELECT 1 FROM projection_turns AS turn
                WHERE turn.thread_id = requested.thread_id AND turn.turn_id = requested.turn_id
                  AND turn.state IN ('completed', 'interrupted', 'error')
              )
            )
        )
        SELECT thread_id AS "threadId", kind, turn_id AS "turnId" FROM unresolved
      `,
      // T3-CUSTOM(expbkt3): A persisted terminal stale response retires the
      // short-lived live-event fallback map once its projection lands.
      sql<PersistedResolutionRow & { readonly threadId: string }>`
        SELECT DISTINCT thread_id AS "threadId", json_extract(payload_json, '$.requestId') AS "requestId"
        FROM projection_thread_activities
        WHERE thread_id IN (SELECT value FROM json_each(${threadIds}))
          -- T3-CUSTOM(expbkt3): avoid decoding unrelated tool history during every sync.
          AND kind IN ('approval.resolved', 'user-input.resolved', 'provider.user-input.respond.failed')
          AND json_extract(payload_json, '$.requestId') IS NOT NULL
          AND (
            kind IN ('approval.resolved', 'user-input.resolved')
            OR (
              kind = 'provider.user-input.respond.failed'
              AND (
                lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%stale pending user-input request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user-input request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending user input request%'
                OR lower(COALESCE(json_extract(payload_json, '$.detail'), '')) LIKE '%unknown pending codex user input request%'
              )
            )
          )
      `,
    ]).pipe(
      Effect.map(([rows, blockers, resolutions]) => {
        const rowByThread = new Map(rows.map((row) => [row.threadId, row] as const));
        const blockersByThread = Map.groupBy(blockers, (blocker) => blocker.threadId);
        const resolutionsByThread = Map.groupBy(resolutions, (resolution) => resolution.threadId);
        return snapshots.map((snapshot) => {
          const providerTurnId = snapshot.turn?.providerTurnId ?? "";
          return mergeCurrentIntent(
            snapshot,
            rowByThread.get(snapshot.threadId),
            (blockersByThread.get(snapshot.threadId) ?? []).filter(
              (blocker) => blocker.turnId === null || blocker.turnId === providerTurnId,
            ),
            resolutionsByThread.get(snapshot.threadId) ?? [],
          );
        });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("durable execution intent snapshot join failed", {
          threadIds: snapshots.map((snapshot) => snapshot.threadId),
          cause,
        }).pipe(Effect.as(snapshots)),
      ),
    );
  };

  const withCurrentIntent = (snapshot: ThreadExecutionSnapshot) =>
    Effect.map(withCurrentIntents([snapshot]), (merged) => merged[0] ?? snapshot);

  const emptySnapshot = (threadId: ThreadId, observedAt: string): ThreadExecutionSnapshot => ({
    threadId,
    authorityEpoch,
    revision: 0,
    observedAt,
    activity: "idle",
    canStop: false,
    providerSession: {
      state: "absent",
      generation: 0,
      providerInstanceId: null,
      startedAt: null,
      lastObservedAt: null,
      lastError: null,
    },
    turn: null,
  });

  const legacyStatusFor = (snapshot: ThreadExecutionSnapshot) =>
    snapshot.activity === "failed"
      ? "error"
      : isActiveActivity(snapshot.activity)
        ? "running"
        : snapshot.providerSession.state === "ready"
          ? "ready"
          : "stopped";

  const persist = Effect.fn("ThreadExecutionSupervisor.persist")(function* (
    snapshot: ThreadExecutionSnapshot,
  ) {
    yield* sql`
      INSERT INTO projection_thread_executions (
        thread_id, authority_epoch, revision, observed_at, activity, can_stop,
        provider_session_state, provider_generation, provider_instance_id,
        provider_started_at, provider_last_observed_at, provider_last_error,
        execution_id, provider_turn_id, turn_state, turn_started_at,
        stop_requested_at, turn_completed_at, turn_last_error
      ) VALUES (
        ${snapshot.threadId}, ${snapshot.authorityEpoch}, ${snapshot.revision},
        ${snapshot.observedAt}, ${snapshot.activity}, ${snapshot.canStop ? 1 : 0},
        ${snapshot.providerSession.state}, ${snapshot.providerSession.generation},
        ${snapshot.providerSession.providerInstanceId}, ${snapshot.providerSession.startedAt},
        ${snapshot.providerSession.lastObservedAt}, ${snapshot.providerSession.lastError},
        ${snapshot.turn?.executionId ?? null}, ${snapshot.turn?.providerTurnId ?? null},
        ${snapshot.turn?.state ?? null}, ${snapshot.turn?.startedAt ?? null},
        ${snapshot.turn?.stopRequestedAt ?? null}, ${snapshot.turn?.completedAt ?? null},
        ${snapshot.turn?.lastError ?? null}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        authority_epoch = excluded.authority_epoch,
        revision = excluded.revision,
        observed_at = excluded.observed_at,
        activity = excluded.activity,
        can_stop = excluded.can_stop,
        provider_session_state = excluded.provider_session_state,
        provider_generation = excluded.provider_generation,
        provider_instance_id = excluded.provider_instance_id,
        provider_started_at = excluded.provider_started_at,
        provider_last_observed_at = excluded.provider_last_observed_at,
        provider_last_error = excluded.provider_last_error,
        execution_id = excluded.execution_id,
        provider_turn_id = excluded.provider_turn_id,
        turn_state = excluded.turn_state,
        turn_started_at = excluded.turn_started_at,
        stop_requested_at = excluded.stop_requested_at,
        turn_completed_at = excluded.turn_completed_at,
        turn_last_error = excluded.turn_last_error
    `;
    const legacyStatus = legacyStatusFor(snapshot);
    // Compatibility dual-write during the cutover. This row is no longer an
    // input to execution authority, but older clients must converge instead
    // of preserving a contradictory running status.
    yield* sql`
      UPDATE projection_thread_sessions
      SET status = ${legacyStatus},
          active_turn_id = ${isActiveActivity(snapshot.activity) ? (snapshot.turn?.providerTurnId ?? null) : null},
          last_error = ${snapshot.turn?.lastError ?? snapshot.providerSession.lastError},
          updated_at = ${snapshot.observedAt}
      WHERE thread_id = ${snapshot.threadId}
    `;
  });

  const appendExecutionEvent = Effect.fn("ThreadExecutionSupervisor.appendExecutionEvent")(
    function* (
      eventType:
        | "thread.execution-stop-requested"
        | "thread.execution-state-changed"
        | "thread.execution-stop-failed",
      snapshot: ThreadExecutionSnapshot,
    ) {
      yield* sql`
        INSERT INTO thread_execution_events (
          thread_id, authority_epoch, revision, event_type, execution_id,
          activity, turn_state, error, occurred_at
        ) VALUES (
          ${snapshot.threadId}, ${snapshot.authorityEpoch}, ${snapshot.revision}, ${eventType},
          ${snapshot.turn?.executionId ?? null}, ${snapshot.activity},
          ${snapshot.turn?.state ?? null},
          ${snapshot.turn?.lastError ?? snapshot.providerSession.lastError},
          ${snapshot.observedAt}
        )
      `;
    },
  );

  // T3-CUSTOM(expbkt3): BEGIN — session recovery desired-state.
  //
  // Recovery bookkeeping must never break execution, so every write is
  // fail-soft. The cost of a lost write is bounded: a missed "running" simply
  // means no auto-reconnect, and a missed "stopped" is caught by the sweep's
  // live-snapshot check before it can restart anything a user stopped.
  const recordRecoveryIntent = (
    operation: Effect.Effect<void, SessionRecoveryStateRepositoryError>,
    context: { readonly threadId: ThreadId; readonly reason: string },
  ) =>
    operation.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("session.recovery.intent-write-failed", {
          threadId: context.threadId,
          reason: context.reason,
          cause,
        }),
      ),
    );

  const recordRecoveryIntentForEvent = (
    event: ProviderRuntimeEvent,
    before: ThreadExecutionSnapshot | undefined,
  ) =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const threadId = event.threadId;
      switch (event.type) {
        // A settled turn — completed, or aborted by the provider — is not
        // something to reconnect. Only an unasked-for death is.
        case "turn.completed":
        case "turn.aborted":
          return yield* recordRecoveryIntent(
            recoveryState.markStopped({ threadId, reason: `turn-settled:${event.type}`, at }),
            { threadId, reason: "turn-settled" },
          );
        case "session.exited": {
          const failed = event.payload.exitKind === "error";
          const hadLiveTurn = before?.turn != null && !isTerminalTurn(before);
          const wasAskedToStop = before?.turn?.stopRequestedAt != null;
          if (failed && hadLiveTurn && !wasAskedToStop) {
            // The session died mid-turn with nobody asking: leave the desired
            // state at "running" so the sweep reconnects it.
            return yield* recordRecoveryIntent(
              recoveryState.noteUnexpectedDown({
                threadId,
                reason: "session-exited-error",
                at,
              }),
              { threadId, reason: "session-exited-error" },
            );
          }
          return yield* recordRecoveryIntent(
            recoveryState.markStopped({
              threadId,
              reason: failed ? "session-exited-error-settled" : "session-exited-graceful",
              at,
            }),
            { threadId, reason: "session-exited" },
          );
        }
        default:
          return;
      }
    });
  // T3-CUSTOM(expbkt3): END

  const publish = Effect.fn("ThreadExecutionSupervisor.publish")(function* (
    snapshot: ThreadExecutionSnapshot,
  ) {
    // T3-CUSTOM(expbkt3): query after the intent transition and before the frame.
    const publicSnapshot = yield* withCurrentIntent(snapshot);
    state.set(publicSnapshot.threadId, publicSnapshot);
    // T3-CUSTOM(expbkt3): a freshly admitted turn is explicit intent to run.
    if (publicSnapshot.turn?.state === "starting" && publicSnapshot.canStop) {
      yield* recordRecoveryIntent(
        recoveryState.markRunning({
          threadId: publicSnapshot.threadId,
          executionId: publicSnapshot.turn.executionId,
          reason: "turn-admitted",
          at: publicSnapshot.observedAt,
        }),
        { threadId: publicSnapshot.threadId, reason: "turn-admitted" },
      );
    }
    const gaugeCounts = new Map<string, number>();
    for (const entry of state.values()) {
      const key = `${entry.providerSession.providerInstanceId ?? "unknown"}\u0000${entry.activity}`;
      gaugeCounts.set(key, (gaugeCounts.get(key) ?? 0) + 1);
    }
    for (const key of new Set([...observedGaugeKeys, ...gaugeCounts.keys()])) {
      const [providerInstanceId, activity] = key.split("\u0000");
      yield* setMetric(
        threadExecutionsActive,
        { providerInstanceId: providerInstanceId ?? "unknown", activity: activity ?? "unknown" },
        gaugeCounts.get(key) ?? 0,
      );
      observedGaugeKeys.add(key);
    }
    yield* persist(publicSnapshot);
    yield* appendExecutionEvent("thread.execution-state-changed", publicSnapshot);
    yield* PubSub.publish(snapshots, publicSnapshot);
    if (publicSnapshot.turn && isTerminalTurn(publicSnapshot)) {
      const waiters = terminalWaiters.get(publicSnapshot.turn.executionId);
      if (waiters) {
        yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, publicSnapshot), {
          discard: true,
        });
      }
    }
    return publicSnapshot;
  });

  const transition = (
    threadId: ThreadId,
    update: (
      current: ThreadExecutionSnapshot,
      observedAt: string,
    ) => ThreadExecutionSnapshot | null,
  ) =>
    transitions.withPermit(
      Effect.gen(function* () {
        const observedAt = yield* nowIso;
        const current = state.get(threadId) ?? emptySnapshot(threadId, observedAt);
        const next = update(current, observedAt);
        if (next === null) return current;
        const revised = {
          ...next,
          authorityEpoch,
          revision: current.revision + 1,
          observedAt,
        };
        const published = yield* publish(revised);
        yield* increment(threadExecutionTransitionsTotal, {
          activity: revised.activity,
          providerInstanceId: revised.providerSession.providerInstanceId ?? "unknown",
          providerSessionState: revised.providerSession.state,
          turnState: revised.turn?.state ?? "none",
        });
        yield* Effect.logDebug("thread execution state changed", {
          threadId,
          authorityEpoch,
          revision: revised.revision,
          activity: revised.activity,
          providerGeneration: revised.providerSession.generation,
          executionId: revised.turn?.executionId,
          turnState: revised.turn?.state,
        });
        return published;
      }),
    );

  const loaded = yield* sql<ExecutionRow>`
    SELECT
      thread_id AS "threadId", authority_epoch AS "authorityEpoch", revision,
      observed_at AS "observedAt", activity, can_stop AS "canStop",
      provider_session_state AS "providerSessionState",
      provider_generation AS "providerGeneration",
      provider_instance_id AS "providerInstanceId",
      provider_started_at AS "providerStartedAt",
      provider_last_observed_at AS "providerLastObservedAt",
      provider_last_error AS "providerLastError", execution_id AS "executionId",
      provider_turn_id AS "providerTurnId", turn_state AS "turnState",
      turn_started_at AS "turnStartedAt", stop_requested_at AS "stopRequestedAt",
      turn_completed_at AS "turnCompletedAt", turn_last_error AS "turnLastError"
    FROM projection_thread_executions
  `;
  for (const row of loaded) {
    const previous = rowToSnapshot(row);
    const observedAt = yield* nowIso;
    const settled: ThreadExecutionSnapshot = {
      ...previous,
      authorityEpoch,
      revision: previous.revision + 1,
      observedAt,
      activity: isActiveActivity(previous.activity) ? "idle" : previous.activity,
      canStop: previous.activity === "failed" ? previous.canStop : false,
      providerSession: {
        ...previous.providerSession,
        state: "stopped",
        lastObservedAt: observedAt,
      },
      turn:
        previous.turn && !isTerminalTurn(previous)
          ? {
              ...previous.turn,
              state: "interrupted",
              completedAt: observedAt,
              lastError: "Server authority restarted before a terminal provider observation.",
            }
          : previous.turn,
    };
    state.set(settled.threadId, settled);
    yield* persist(settled);
    yield* appendExecutionEvent("thread.execution-state-changed", settled);
    yield* increment(threadExecutionInvariantRepairsTotal, {
      mismatch: "startup-old-authority-epoch",
    });
    yield* Effect.logInfo("settled execution from an older server authority epoch", {
      threadId: settled.threadId,
      previousAuthorityEpoch: previous.authorityEpoch,
      authorityEpoch,
      revision: settled.revision,
      previousActivity: previous.activity,
    });
  }

  // T3-CUSTOM(expbkt3): native commands can finish before the hot event subscriber
  // catches up. Fence only that subscriber; explicit queued dispatch still prepares.
  const handledCommandSequences = new Map<ThreadId, number>();
  const prepareExecutionEvent = (
    event: Parameters<ThreadExecutionSupervisorShape["prepareExecution"]>[0],
    fromSubscription = false,
  ) =>
    transition(event.payload.threadId, (current, observedAt) => {
      if (
        fromSubscription &&
        event.sequence <= (handledCommandSequences.get(event.payload.threadId) ?? -1)
      )
        return null;
      const executionId = String(event.commandId ?? event.eventId);
      if (
        current.turn?.executionId === executionId ||
        current.canStop ||
        (current.turn && !isTerminalTurn(current))
      ) {
        return null;
      }
      const replaceProvider =
        current.providerSession.state === "absent" ||
        current.providerSession.state === "stopped" ||
        current.providerSession.state === "failed";
      return {
        ...current,
        activity: "active",
        canStop: true,
        providerSession: {
          ...current.providerSession,
          providerInstanceId:
            event.payload.modelSelection?.instanceId ?? current.providerSession.providerInstanceId,
          state: replaceProvider ? "starting" : current.providerSession.state,
          // ProviderService owns the adapter generation. Do not predict its
          // next value here: its counter can legitimately differ after a
          // server restart or recovered session. The first observation from
          // the selected provider adopts the actual generation below.
          generation: current.providerSession.generation,
          startedAt: replaceProvider ? observedAt : current.providerSession.startedAt,
          lastObservedAt: observedAt,
          lastError: null,
        },
        turn: {
          executionId,
          providerTurnId: null,
          state: "starting",
          startedAt: event.payload.createdAt,
          stopRequestedAt: null,
          completedAt: null,
          lastError: null,
        },
      };
    });

  const prepareExecution: ThreadExecutionSupervisorShape["prepareExecution"] = (event) =>
    prepareExecutionEvent(event);

  // T3-CUSTOM(expbkt3): durable recovery deliberately reuses the original
  // execution id while opening a new provider turn under a fenced claim.
  const recoverExecution: ThreadExecutionSupervisorShape["recoverExecution"] = (event) =>
    transition(event.payload.threadId, (current, observedAt) => ({
      ...current,
      activity: "active",
      canStop: true,
      providerSession: {
        ...current.providerSession,
        providerInstanceId:
          event.payload.modelSelection?.instanceId ?? current.providerSession.providerInstanceId,
        state: current.providerSession.state === "ready" ? "ready" : "starting",
        startedAt: current.providerSession.startedAt ?? observedAt,
        lastObservedAt: observedAt,
        lastError: null,
      },
      turn: {
        executionId: String(event.commandId ?? event.eventId),
        providerTurnId: null,
        state: "starting",
        startedAt: observedAt,
        stopRequestedAt: null,
        completedAt: null,
        lastError: null,
      },
    }));

  const admitIdleTurn: ThreadExecutionSupervisorShape["admitIdleTurn"] = (input) =>
    transitions.withPermit(
      Effect.gen(function* () {
        const observedAt = yield* nowIso;
        const current = state.get(input.threadId) ?? emptySnapshot(input.threadId, observedAt);
        if (current.turn?.executionId === input.executionId) {
          return current;
        }
        if (current.revision !== input.expectedExecutionRevision) {
          return yield* new ThreadTurnAdmissionConflictError({
            threadId: input.threadId,
            executionId: input.executionId,
            reason: "execution_revision_mismatch",
            expectedExecutionRevision: input.expectedExecutionRevision,
            actualExecutionRevision: current.revision,
            activity: current.activity,
          });
        }
        if (
          current.activity !== "idle" ||
          current.canStop ||
          (current.turn !== null && !isTerminalTurn(current))
        ) {
          return yield* new ThreadTurnAdmissionConflictError({
            threadId: input.threadId,
            executionId: input.executionId,
            reason: "thread_not_idle",
            expectedExecutionRevision: input.expectedExecutionRevision,
            actualExecutionRevision: current.revision,
            activity: current.activity,
          });
        }
        const replaceProvider =
          current.providerSession.state === "absent" ||
          current.providerSession.state === "stopped" ||
          current.providerSession.state === "failed";
        const admitted: ThreadExecutionSnapshot = {
          ...current,
          authorityEpoch,
          revision: current.revision + 1,
          observedAt,
          activity: "active",
          canStop: true,
          providerSession: {
            ...current.providerSession,
            providerInstanceId:
              input.providerInstanceId ?? current.providerSession.providerInstanceId,
            state: replaceProvider ? "starting" : current.providerSession.state,
            startedAt: replaceProvider ? observedAt : current.providerSession.startedAt,
            lastObservedAt: observedAt,
            lastError: null,
          },
          turn: {
            executionId: input.executionId,
            providerTurnId: null,
            state: "starting",
            startedAt: input.startedAt,
            stopRequestedAt: null,
            completedAt: null,
            lastError: null,
          },
        };
        yield* publish(admitted);
        yield* increment(threadExecutionTransitionsTotal, {
          activity: admitted.activity,
          providerInstanceId: admitted.providerSession.providerInstanceId ?? "unknown",
          providerSessionState: admitted.providerSession.state,
          turnState: admitted.turn?.state ?? "none",
        });
        return admitted;
      }),
    );

  const releaseTurnAdmission: ThreadExecutionSupervisorShape["releaseTurnAdmission"] = (
    threadId,
    executionId,
    handledCommandSequence,
  ) =>
    transition(threadId, (current, observedAt) => {
      if (handledCommandSequence !== undefined) {
        handledCommandSequences.set(
          threadId,
          Math.max(handledCommandSequence, handledCommandSequences.get(threadId) ?? -1),
        );
      }
      if (
        current.turn?.executionId !== executionId ||
        current.turn.providerTurnId !== null ||
        current.turn.state !== "starting"
      ) {
        return null;
      }
      return {
        ...current,
        activity: "idle",
        canStop: false,
        providerSession: {
          ...current.providerSession,
          state:
            current.providerSession.state === "starting"
              ? "stopped"
              : current.providerSession.state,
          lastObservedAt: observedAt,
          lastError: null,
        },
        turn: null,
      };
    });

  const observeProviderEvent = (event: ProviderRuntimeEvent) => {
    const currentSnapshot = state.get(event.threadId);
    // T3-CUSTOM(expbkt3): Credential handoff can replace a ready provider while
    // the admitted turn is starting, so adopt the replacement's newer generation.
    const mayAdoptStartingGeneration =
      currentSnapshot?.turn?.state === "starting" &&
      (currentSnapshot.providerSession.state === "starting" ||
        (event.sessionGeneration !== undefined &&
          event.sessionGeneration > currentSnapshot.providerSession.generation)) &&
      (event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "turn.started") &&
      Date.parse(event.createdAt) >= Date.parse(currentSnapshot.turn.startedAt) &&
      (currentSnapshot.providerSession.providerInstanceId === null ||
        event.providerInstanceId === undefined ||
        event.providerInstanceId === currentSnapshot.providerSession.providerInstanceId);
    if (
      currentSnapshot &&
      event.sessionGeneration !== undefined &&
      event.sessionGeneration !== currentSnapshot.providerSession.generation &&
      !mayAdoptStartingGeneration
    ) {
      return increment(threadExecutionGenerationRejectionsTotal, {
        provider: event.provider,
        eventType: event.type,
      }).pipe(
        Effect.andThen(
          Effect.logWarning("stale provider event rejected by generation fence", {
            threadId: event.threadId,
            eventType: event.type,
            eventGeneration: event.sessionGeneration,
            supervisorGeneration: currentSnapshot.providerSession.generation,
          }),
        ),
      );
    }
    return transition(event.threadId, (current, observedAt) => {
      const providerInstanceId =
        event.providerInstanceId ?? current.providerSession.providerInstanceId;
      const providerSession = {
        ...current.providerSession,
        generation: event.sessionGeneration ?? current.providerSession.generation,
        providerInstanceId: providerInstanceId ?? null,
        lastObservedAt: observedAt,
      };
      switch (event.type) {
        case "session.started":
          if (
            isTerminalTurn(current) &&
            (current.providerSession.state === "stopped" ||
              current.providerSession.state === "stopping" ||
              current.providerSession.state === "failed")
          ) {
            return null;
          }
          return {
            ...current,
            providerSession: {
              ...providerSession,
              state: "ready",
              startedAt: current.providerSession.startedAt ?? observedAt,
              lastError: null,
            },
          };
        case "session.state.changed": {
          const stateValue = event.payload.state;
          const nextState =
            stateValue === "starting"
              ? "starting"
              : stateValue === "ready"
                ? "ready"
                : stateValue === "running" || stateValue === "waiting"
                  ? "ready"
                  : stateValue === "error"
                    ? "failed"
                    : "stopped";
          if (
            (stateValue === "starting" || stateValue === "ready") &&
            isTerminalTurn(current) &&
            (current.providerSession.state === "stopped" ||
              current.providerSession.state === "stopping" ||
              current.providerSession.state === "failed")
          ) {
            return null;
          }
          const failed = stateValue === "error";
          const reason = event.payload.reason ?? "Provider session failed.";
          return {
            ...current,
            activity:
              failed && current.turn && !isTerminalTurn(current) ? "failed" : current.activity,
            canStop: failed ? false : current.canStop,
            providerSession: {
              ...providerSession,
              state: nextState,
              lastError: failed ? reason : null,
            },
            turn:
              failed && current.turn && !isTerminalTurn(current)
                ? {
                    ...current.turn,
                    state: "failed",
                    completedAt: observedAt,
                    lastError: reason,
                  }
                : current.turn,
          };
        }
        case "turn.started":
          if (!current.turn || current.turn.state === "stopping") return current;
          return {
            ...current,
            activity: "active",
            canStop: true,
            providerSession: { ...providerSession, state: "ready" },
            turn: {
              ...current.turn,
              providerTurnId: event.turnId ?? current.turn.providerTurnId,
              state: "running",
            },
          };
        case "request.opened":
        case "user-input.requested":
          if (!current.turn || isTerminalTurn(current)) return current;
          // T3-CUSTOM(expbkt3): Codex message-mode questions are an invitation
          // to steer the active agent, not a provider-stream pause.  Keeping
          // this snapshot active is important because the matching answer is
          // appended as a normal message and therefore has no runtime
          // `user-input.resolved` event to undo a synthetic blocked state.
          if (event.type === "user-input.requested" && event.payload.responseMode === "message") {
            return current;
          }
          {
            const blockers = blockingRequestIds.get(event.threadId) ?? new Set<string>();
            blockers.add(event.requestId ?? "legacy-blocking-request");
            blockingRequestIds.set(event.threadId, blockers);
          }
          return {
            ...current,
            activity: "blocked",
            canStop: true,
            providerSession: { ...providerSession, state: "ready" },
            turn: {
              ...current.turn,
              state:
                event.type === "user-input.requested"
                  ? "waiting-for-input"
                  : "waiting-for-approval",
            },
          };
        case "request.resolved":
        case "user-input.resolved":
          if (!current.turn || isTerminalTurn(current)) return current;
          {
            const blockers = blockingRequestIds.get(event.threadId);
            if (blockers !== undefined) {
              if (event.requestId === undefined) blockers.delete("legacy-blocking-request");
              else blockers.delete(event.requestId);
              if (blockers.size === 0) blockingRequestIds.delete(event.threadId);
              else return current;
            }
          }
          return {
            ...current,
            activity: current.activity === "stopping" ? "stopping" : "active",
            providerSession: { ...providerSession, state: "ready" },
            turn: {
              ...current.turn,
              state: current.turn.state === "stopping" ? "stopping" : "running",
            },
          };
        case "turn.completed":
        case "turn.aborted": {
          if (!current.turn) return current;
          if (
            event.turnId !== undefined &&
            current.turn.providerTurnId !== null &&
            event.turnId !== current.turn.providerTurnId
          )
            return null;
          const interrupted = event.type === "turn.aborted";
          blockingRequestIds.delete(event.threadId);
          return {
            ...current,
            activity: "idle",
            canStop: false,
            providerSession: {
              ...providerSession,
              state: "ready",
              lastError: null,
            },
            turn: {
              ...current.turn,
              providerTurnId: event.turnId ?? current.turn.providerTurnId,
              state: interrupted ? "interrupted" : "completed",
              completedAt: observedAt,
              lastError: null,
            },
          };
        }
        case "session.exited": {
          const failed = event.payload.exitKind === "error";
          return {
            ...current,
            activity:
              current.turn && !isTerminalTurn(current)
                ? failed
                  ? "failed"
                  : "idle"
                : current.activity,
            // The independent runtime watcher observed a real exit. A failed
            // turn remains visible, but there is no process left to stop.
            canStop: false,
            providerSession: {
              ...providerSession,
              state: failed ? "failed" : "stopped",
              lastError: failed ? (event.payload.reason ?? "Provider session exited.") : null,
            },
            turn:
              current.turn && !isTerminalTurn(current)
                ? {
                    ...current.turn,
                    state: failed ? "failed" : "interrupted",
                    completedAt: observedAt,
                    lastError: event.payload.reason ?? null,
                  }
                : current.turn,
          };
        }
        default:
          return null;
      }
    }).pipe(
      // T3-CUSTOM(expbkt3): record recovery intent from the same event, using
      // the pre-transition snapshot to tell a mid-turn crash from a settle.
      Effect.tap(() => recordRecoveryIntentForEvent(event, currentSnapshot)),
    );
  };

  const getSnapshot: ThreadExecutionSupervisorShape["getSnapshot"] = (threadId) =>
    Effect.gen(function* () {
      const current = state.get(threadId);
      return yield* withCurrentIntent(current ?? emptySnapshot(threadId, yield* nowIso));
    });

  const getSnapshots: ThreadExecutionSupervisorShape["getSnapshots"] = (threadIds) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const entries = yield* withCurrentIntents(
        threadIds.map((threadId) => state.get(threadId) ?? emptySnapshot(threadId, now)),
      );
      return new Map(entries.map((entry) => [entry.threadId, entry]));
    });

  // T3-CUSTOM(expbkt3): coordinator changes get a revisioned websocket frame.
  const refreshIntent: ThreadExecutionSupervisorShape["refreshIntent"] = (threadId) =>
    transition(threadId, (current) => ({ ...current }));

  const canContinueExecution: ThreadExecutionSupervisorShape["canContinueExecution"] = (
    threadId,
    executionId,
  ) =>
    getSnapshot(threadId).pipe(
      Effect.map(
        (snapshot) =>
          snapshot.turn?.executionId === executionId &&
          (snapshot.activity === "active" || snapshot.activity === "blocked"),
      ),
    );

  const failExecution: ThreadExecutionSupervisorShape["failExecution"] = (
    threadId,
    executionId,
    error,
  ) =>
    transition(threadId, (current, observedAt) => {
      if (current.turn?.executionId !== executionId || isTerminalTurn(current)) return null;
      return {
        ...current,
        activity: "failed",
        canStop: false,
        providerSession: {
          ...current.providerSession,
          state: "failed",
          lastObservedAt: observedAt,
          lastError: error,
        },
        turn: {
          ...current.turn,
          state: "failed",
          completedAt: observedAt,
          lastError: error,
        },
      };
    }).pipe(
      // T3-CUSTOM(expbkt3): a deterministic turn-start failure (bad config,
      // missing binary) will fail identically on every retry — never let
      // infrastructure loop on it.
      Effect.tap(() =>
        Effect.flatMap(nowIso, (at) =>
          recordRecoveryIntent(
            recoveryState.markStopped({ threadId, reason: "turn-start-failed", at }),
            { threadId, reason: "turn-start-failed" },
          ),
        ),
      ),
    );

  const awaitTerminal = (threadId: ThreadId, executionId: string, timeoutMs: number) =>
    Effect.gen(function* () {
      const current = yield* getSnapshot(threadId);
      if (current.turn?.executionId !== executionId || isTerminalTurn(current)) return current;
      const waiter = yield* Deferred.make<ThreadExecutionSnapshot>();
      const waiters = terminalWaiters.get(executionId) ?? new Set();
      waiters.add(waiter);
      terminalWaiters.set(executionId, waiters);

      // Re-read after registering. A terminal transition between the first
      // read and waiter registration is therefore observed here rather than
      // becoming a lost wake-up.
      const afterRegistration = yield* getSnapshot(threadId);
      if (
        afterRegistration.turn?.executionId !== executionId ||
        isTerminalTurn(afterRegistration)
      ) {
        yield* Deferred.succeed(waiter, afterRegistration);
      }

      return yield* Deferred.await(waiter).pipe(
        Effect.timeoutOption(timeoutMs),
        Effect.map(Option.getOrNull),
        Effect.ensuring(
          Effect.sync(() => {
            waiters.delete(waiter);
            if (waiters.size === 0) terminalWaiters.delete(executionId);
          }),
        ),
      );
    });

  const stopExecutionUnlocked: ThreadExecutionSupervisorShape["stopExecution"] = Effect.fn(
    "ThreadExecutionSupervisor.stopExecution",
  )(function* (input) {
    let initial = yield* getSnapshot(input.threadId);
    // T3-CUSTOM(expbkt3): the latest snapshot can describe a queued follow-up
    // while an earlier item owns the active setup. Inspect durable operations
    // before the stop fence so the child cannot outlive a UI Stop.
    let ownedSetupTerminal: string | null = null;
    if (Option.isSome(durableIntentRepository)) {
      const items = yield* durableIntentRepository.value.listByThreadId({
        threadId: input.threadId,
      });
      for (const item of items.toReversed()) {
        const operation = yield* durableIntentRepository.value.getBootstrapOperation({
          workItemId: item.workItemId,
        });
        if (Option.isSome(operation) && operation.value.setupPhase === "running") {
          ownedSetupTerminal = operation.value.setupTerminalId;
          break;
        }
      }
    }
    // T3-CUSTOM(expbkt3): the user asked for this stop. Record the intent
    // before anything else — including on the already-stopped path, where the
    // intent is just as real — so recovery can never race a stop request and
    // reconnect a session somebody deliberately ended.
    const stoppedAt = yield* nowIso;
    if (Option.isSome(durableIntentRepository)) {
      yield* durableIntentRepository.value.stopThread({
        threadId: input.threadId,
        reason: "user-stop",
        at: stoppedAt,
      });
      // T3-CUSTOM(expbkt3): WebSocket Stop fences the durable item directly,
      // without a later ProviderCommandReactor event. Capture the terminal
      // before that fence and stop only its running setup child afterwards.
      if (ownedSetupTerminal !== null && Option.isSome(terminalManager)) {
        yield* terminalManager.value
          .stopCommand({ threadId: input.threadId, terminalId: ownedSetupTerminal })
          .pipe(Effect.catch(() => Effect.void));
      }
      // Queued work may not have a provider snapshot to transition below. Publish
      // the fenced desired state now so every connected client drops active UI.
      initial = yield* refreshIntent(input.threadId);
    }
    yield* recordRecoveryIntent(
      recoveryState.markStopped({
        threadId: input.threadId,
        reason: "user-stop",
        at: stoppedAt,
      }),
      { threadId: input.threadId, reason: "user-stop" },
    );
    const executionId = initial.turn?.executionId;
    if (executionId !== undefined) {
      const completed = completedStopOperations.get(executionId);
      if (completed) return completed;
    }
    const operationId =
      executionId === undefined
        ? yield* crypto.randomUUIDv4.pipe(Effect.orDie)
        : (stopOperations.get(executionId) ?? (yield* crypto.randomUUIDv4.pipe(Effect.orDie)));
    if (executionId !== undefined) stopOperations.set(executionId, operationId);
    if (
      executionId === undefined ||
      !initial.canStop ||
      (input.expectedExecutionId !== undefined && input.expectedExecutionId !== executionId)
    ) {
      const result = {
        operationId,
        disposition: "already-stopped",
        snapshot: initial,
      } satisfies OrchestrationStopExecutionResult;
      if (
        executionId !== undefined &&
        (input.expectedExecutionId === undefined || input.expectedExecutionId === executionId)
      ) {
        completedStopOperations.set(executionId, result);
      }
      return result;
    }

    const stopping = yield* transition(input.threadId, (current, observedAt) => {
      if (current.turn?.executionId !== executionId || !current.canStop) return null;
      return {
        ...current,
        activity: "stopping",
        canStop: true,
        providerSession: { ...current.providerSession, state: "stopping" },
        turn: { ...current.turn, state: "stopping", stopRequestedAt: observedAt },
      };
    });
    yield* appendExecutionEvent("thread.execution-stop-requested", stopping);

    let inspection = yield* provider.inspectSession(input.threadId).pipe(Effect.result);
    if (inspection._tag === "Failure") {
      yield* Effect.logWarning("provider session inspection failed during stop escalation", {
        threadId: input.threadId,
        executionId,
        cause: String(inspection.failure),
      });
    }
    if (
      inspection._tag === "Success" &&
      inspection.success === null &&
      initial.providerSession.state === "starting"
    ) {
      const startupTerminal = yield* awaitTerminal(input.threadId, executionId, 5_000);
      if (startupTerminal !== null) {
        const result = {
          operationId,
          disposition: "stopping",
          snapshot: startupTerminal,
        } as const;
        completedStopOperations.set(executionId, result);
        return result;
      }
      inspection = yield* provider.inspectSession(input.threadId).pipe(Effect.result);
    }
    if (inspection._tag === "Success" && inspection.success === null) {
      const settled = yield* transition(input.threadId, (current, observedAt) => ({
        ...current,
        activity: "idle",
        canStop: false,
        providerSession: {
          ...current.providerSession,
          state: "stopped",
          lastObservedAt: observedAt,
        },
        turn: current.turn
          ? { ...current.turn, state: "interrupted", completedAt: observedAt, lastError: null }
          : null,
      }));
      const result = { operationId, disposition: "already-stopped", snapshot: settled } as const;
      completedStopOperations.set(executionId, result);
      return result;
    }

    // A stop requested before provider startup completed already spent up to
    // five seconds waiting for spawn cancellation. If a runtime appeared in
    // that window, terminate it directly so the whole operation still fits
    // the 15-second acceptance bound.
    if (initial.providerSession.state !== "starting") {
      const interrupt = yield* provider
        .requestTurnInterrupt({
          threadId: input.threadId,
          ...(initial.turn?.providerTurnId !== null && initial.turn?.providerTurnId !== undefined
            ? { turnId: initial.turn.providerTurnId }
            : {}),
        })
        .pipe(
          Effect.timeoutOption("3 seconds"),
          withMetrics({
            timer: threadExecutionStopAcknowledgementDuration,
            attributes: {
              providerInstanceId: initial.providerSession.providerInstanceId ?? "unknown",
            },
          }),
          Effect.result,
        );
      if (interrupt._tag === "Failure" || Option.isNone(interrupt.success)) {
        yield* Effect.logWarning("provider turn interrupt was not acknowledged", {
          threadId: input.threadId,
          executionId,
          ...(interrupt._tag === "Failure" ? { cause: String(interrupt.failure) } : {}),
        });
      }
      const terminal = yield* awaitTerminal(input.threadId, executionId, 5_000);
      if (terminal !== null) {
        const result = { operationId, disposition: "stopping", snapshot: terminal } as const;
        completedStopOperations.set(executionId, result);
        return result;
      }
    }

    yield* increment(threadExecutionStopEscalationsTotal, {
      providerInstanceId: initial.providerSession.providerInstanceId ?? "unknown",
    });
    const termination = yield* provider
      .terminateSession({ threadId: input.threadId })
      .pipe(Effect.timeoutOption("7 seconds"), Effect.result);
    yield* increment(threadExecutionTerminationOutcomesTotal, {
      providerInstanceId: initial.providerSession.providerInstanceId ?? "unknown",
      outcome:
        termination._tag === "Success" && Option.isSome(termination.success)
          ? termination.success.value.verified && termination.success.value.processTreeExited
            ? termination.success.value.graceful
              ? "graceful"
              : "forced"
            : "unverified"
          : "failed",
    });
    if (
      termination._tag === "Success" &&
      Option.isSome(termination.success) &&
      termination.success.value.verified &&
      termination.success.value.processTreeExited
    ) {
      const settled = yield* transition(input.threadId, (current, observedAt) => ({
        ...current,
        activity: "idle",
        canStop: false,
        providerSession: {
          ...current.providerSession,
          state: "stopped",
          lastObservedAt: observedAt,
        },
        turn: current.turn
          ? { ...current.turn, state: "interrupted", completedAt: observedAt, lastError: null }
          : null,
      }));
      const result = { operationId, disposition: "stopping", snapshot: settled } as const;
      completedStopOperations.set(executionId, result);
      return result;
    }

    const failed = yield* transition(input.threadId, (current) => ({
      ...current,
      activity: "failed",
      canStop: true,
      providerSession: {
        ...current.providerSession,
        state: "failed",
        lastError: "Provider process-tree termination could not be verified.",
      },
      turn: current.turn
        ? {
            ...current.turn,
            state: "failed",
            lastError: "Provider process-tree termination could not be verified.",
          }
        : null,
    }));
    yield* appendExecutionEvent("thread.execution-stop-failed", failed);
    yield* Effect.logError("provider process-tree termination could not be verified", {
      threadId: input.threadId,
      executionId,
      operationId,
      providerInstanceId: initial.providerSession.providerInstanceId,
    });
    const result = { operationId, disposition: "stopping", snapshot: failed } as const;
    return result;
  });

  const stopExecution: ThreadExecutionSupervisorShape["stopExecution"] = (input) =>
    Effect.gen(function* () {
      let lock = stopLocks.get(input.threadId);
      if (!lock) {
        lock = yield* Semaphore.make(1);
        stopLocks.set(input.threadId, lock);
      }
      return yield* lock.withPermit(stopExecutionUnlocked(input));
    }).pipe(
      withMetrics({
        timer: threadExecutionStopDuration,
        attributes: { threadId: input.threadId },
      }),
    );

  yield* Stream.runForEach(orchestration.streamDomainEvents, (event) =>
    // T3-CUSTOM(expbkt3): compaction is a provider-native command with no
    // execution to supervise. Skipping it here prevents its own compatibility
    // dual-write from making the later compaction guard see false busy work.
    event.type === "thread.turn-start-requested" && !event.payload.isCompaction
      ? prepareExecutionEvent(event, true)
      : Effect.void,
  ).pipe(Effect.forkScoped);
  yield* Stream.runForEach(provider.streamEvents, observeProviderEvent).pipe(Effect.forkScoped);

  const audit = Effect.suspend(() =>
    Effect.forEach(
      Array.from(state.values()).filter(
        (snapshot) =>
          isActiveActivity(snapshot.activity) ||
          (snapshot.activity === "failed" && snapshot.canStop),
      ),
      (snapshot) =>
        Effect.gen(function* () {
          const inspection = yield* provider.inspectSession(snapshot.threadId);
          // T3-CUSTOM(expbkt3): Durable bootstrap admits the turn before it creates a
          // provider runtime. A missing runtime is expected while both sides are starting;
          // the dispatch path remains responsible for publishing a real startup failure.
          if (
            inspection === null &&
            snapshot.providerSession.state === "starting" &&
            snapshot.turn?.state === "starting"
          ) {
            return;
          }
          if (inspection === null || !inspection.runtimeAlive) {
            yield* increment(threadExecutionInvariantRepairsTotal, {
              mismatch: inspection === null ? "missing-session" : "dead-runtime",
            });
            yield* transition(snapshot.threadId, (current, observedAt) => ({
              ...current,
              activity: "idle",
              canStop: false,
              providerSession: {
                ...current.providerSession,
                state: "stopped",
                lastObservedAt: observedAt,
              },
              turn:
                current.turn && !isTerminalTurn(current)
                  ? { ...current.turn, state: "interrupted", completedAt: observedAt }
                  : current.turn,
            }));
            return;
          }
          if (snapshot.activity === "failed" && snapshot.canStop) {
            const termination = yield* provider
              .terminateSession({ threadId: snapshot.threadId })
              .pipe(Effect.timeoutOption("7 seconds"));
            if (
              Option.isSome(termination) &&
              termination.value.verified &&
              termination.value.processTreeExited
            ) {
              yield* increment(threadExecutionInvariantRepairsTotal, {
                mismatch: "termination-retry-succeeded",
              });
              yield* transition(snapshot.threadId, (current, observedAt) => ({
                ...current,
                activity: "idle",
                canStop: false,
                providerSession: {
                  ...current.providerSession,
                  state: "stopped",
                  lastObservedAt: observedAt,
                  lastError: null,
                },
                turn: current.turn
                  ? {
                      ...current.turn,
                      state: "interrupted",
                      completedAt: observedAt,
                      lastError: null,
                    }
                  : null,
              }));
              return;
            }
          }
          if (
            inspection.generation > 0 &&
            inspection.generation !== snapshot.providerSession.generation
          ) {
            yield* increment(threadExecutionInvariantRepairsTotal, {
              mismatch: "provider-generation",
            });
            yield* Effect.logWarning("provider generation mismatch detected", {
              threadId: snapshot.threadId,
              supervisorGeneration: snapshot.providerSession.generation,
              adapterGeneration: inspection.generation,
            });
            yield* transition(snapshot.threadId, (current, observedAt) => ({
              ...current,
              providerSession: {
                ...current.providerSession,
                generation: inspection.generation,
                state: inspectionProviderState(inspection.state),
                lastObservedAt: observedAt,
              },
              turn:
                current.turn && !isTerminalTurn(current) && inspection.activeProviderTurnId !== null
                  ? {
                      ...current.turn,
                      providerTurnId: inspection.activeProviderTurnId,
                      state: current.turn.state === "stopping" ? "stopping" : "running",
                    }
                  : current.turn,
            }));
          }
          const legacyRows = yield* sql<{ readonly status: string }>`
            SELECT status FROM projection_thread_sessions WHERE thread_id = ${snapshot.threadId}
          `;
          if (legacyRows[0] && legacyRows[0].status !== legacyStatusFor(snapshot)) {
            yield* increment(threadExecutionInvariantRepairsTotal, {
              mismatch: "legacy-projection",
            });
            yield* Effect.logWarning("thread execution projection mismatch repaired", {
              threadId: snapshot.threadId,
              executionStatus: snapshot.activity,
              legacyStatus: legacyRows[0].status,
            });
            yield* persist(snapshot);
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread execution invariant audit failed", {
              threadId: snapshot.threadId,
              cause,
            }),
          ),
        ),
      { discard: true },
    ),
  );
  yield* Effect.forever(Effect.sleep("15 seconds").pipe(Effect.andThen(audit))).pipe(
    Effect.forkScoped,
  );

  return {
    authorityEpoch,
    getSnapshot,
    getSnapshots,
    refreshIntent,
    prepareExecution,
    recoverExecution,
    admitIdleTurn,
    releaseTurnAdmission,
    canContinueExecution,
    failExecution,
    stopExecution,
    get streamSnapshots() {
      return Stream.fromPubSub(snapshots);
    },
  } satisfies ThreadExecutionSupervisorShape;
});

export const ThreadExecutionSupervisorLive = Layer.effect(ThreadExecutionSupervisor, make());
