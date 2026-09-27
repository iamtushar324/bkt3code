// T3-CUSTOM(expbkt3): exact accepted-work repository and compatibility mirror.
import type {
  ModelSelection,
  OrchestrationEvent,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { PersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionThreadMessage } from "../persistence/Services/ProjectionThreadMessages.ts";

export type DurableExecutionDesiredState = "running" | "stopped";
export type DurableExecutionPhase =
  | "queued"
  | "preparing"
  | "starting"
  | "running"
  | "waiting-for-approval"
  | "waiting-for-input"
  | "recovering"
  | "retry-wait"
  | "stopping"
  | "recovery-exhausted";
export type DurableDeliveryCertainty =
  | "never-delivered"
  | "uncertain"
  | "provider-acknowledged"
  | "completed";
export type DurableBootstrapPhase =
  | "pending"
  | "running"
  | "acknowledged"
  | "failed"
  | "uncertain"
  | "not-required";

export interface DurableBootstrapOperation {
  readonly workItemId: string;
  readonly threadId: ThreadId;
  readonly worktreePhase: DurableBootstrapPhase;
  readonly worktreePath: string | null;
  readonly setupPhase: DurableBootstrapPhase;
  readonly setupTerminalId: string;
  readonly lastFailureDetail: string | null;
  readonly updatedAt: string;
}

export interface DurableExecutionIntent {
  readonly workItemId: string;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly commandId: string;
  readonly requestEventSequence: number | null;
  readonly messageText: string | null;
  readonly attachments: ReadonlyArray<unknown>;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
  readonly bootstrap: unknown | null;
  readonly sourceProposedPlan: unknown | null;
  readonly actingUserId: UserId | null;
  readonly desiredState: DurableExecutionDesiredState;
  readonly phase: DurableExecutionPhase;
  readonly deliveryCertainty: DurableDeliveryCertainty;
  readonly runnable: boolean;
  readonly adoptedExecutionId: string | null;
  readonly providerTurnId: string | null;
  readonly providerInstanceId: string | null;
  readonly recoveryAttempts: number;
  readonly maximumRecoveryAttempts: 10;
  readonly nextAttemptAt: string | null;
  readonly claimOwner: string | null;
  readonly claimGeneration: number;
  readonly claimExpiresAt: string | null;
  readonly lastFailureType: string | null;
  readonly lastFailureDetail: string | null;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
  readonly exhaustedAt: string | null;
  readonly dismissedAt: string | null;
}

type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;

interface DurableExecutionIntentRow {
  readonly workItemId: string;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly commandId: string;
  readonly requestEventSequence: number | null;
  readonly messageText: string | null;
  readonly attachmentsJson: string | null;
  readonly modelSelectionJson: string | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly interactionMode: ProviderInteractionMode | null;
  readonly bootstrapJson: string | null;
  readonly sourceProposedPlanJson: string | null;
  readonly actingUserId: UserId | null;
  readonly desiredState: DurableExecutionDesiredState;
  readonly phase: DurableExecutionPhase;
  readonly deliveryCertainty: DurableDeliveryCertainty;
  readonly runnable: number;
  readonly adoptedExecutionId: string | null;
  readonly providerTurnId: string | null;
  readonly providerInstanceId: string | null;
  readonly recoveryAttempts: number;
  readonly maximumRecoveryAttempts: 10;
  readonly nextAttemptAt: string | null;
  readonly claimOwner: string | null;
  readonly claimGeneration: number;
  readonly claimExpiresAt: string | null;
  readonly lastFailureType: string | null;
  readonly lastFailureDetail: string | null;
  readonly acceptedAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
  readonly exhaustedAt: string | null;
  readonly dismissedAt: string | null;
}

const SELECT_COLUMNS = `
  work_item_id AS "workItemId",
  thread_id AS "threadId",
  message_id AS "messageId",
  command_id AS "commandId",
  request_event_sequence AS "requestEventSequence",
  message_text AS "messageText",
  attachments_json AS "attachmentsJson",
  model_selection_json AS "modelSelectionJson",
  runtime_mode AS "runtimeMode",
  interaction_mode AS "interactionMode",
  bootstrap_json AS "bootstrapJson",
  source_proposed_plan_json AS "sourceProposedPlanJson",
  acting_user_id AS "actingUserId",
  desired_state AS "desiredState",
  phase,
  delivery_certainty AS "deliveryCertainty",
  runnable,
  adopted_execution_id AS "adoptedExecutionId",
  provider_turn_id AS "providerTurnId",
  provider_instance_id AS "providerInstanceId",
  recovery_attempts AS "recoveryAttempts",
  maximum_recovery_attempts AS "maximumRecoveryAttempts",
  next_attempt_at AS "nextAttemptAt",
  claim_owner AS "claimOwner",
  claim_generation AS "claimGeneration",
  claim_expires_at AS "claimExpiresAt",
  last_failure_type AS "lastFailureType",
  last_failure_detail AS "lastFailureDetail",
  accepted_at AS "acceptedAt",
  started_at AS "startedAt",
  updated_at AS "updatedAt",
  terminal_at AS "terminalAt",
  exhausted_at AS "exhaustedAt",
  dismissed_at AS "dismissedAt"
`;

function persistenceError(operation: string, cause: unknown, threadId?: ThreadId) {
  return new PersistenceSqlError({
    operation,
    ...(threadId === undefined ? {} : { correlation: { threadId } }),
    cause,
  });
}

function parseJson(value: string | null): unknown | null {
  return value === null
    ? null
    : Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(value);
}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fromRow(row: DurableExecutionIntentRow): DurableExecutionIntent {
  const attachments = parseJson(row.attachmentsJson);
  return {
    workItemId: row.workItemId,
    threadId: row.threadId,
    messageId: row.messageId,
    commandId: row.commandId,
    requestEventSequence: row.requestEventSequence,
    messageText: row.messageText,
    attachments: Array.isArray(attachments) ? attachments : [],
    modelSelection: parseJson(row.modelSelectionJson) as ModelSelection | null,
    runtimeMode: row.runtimeMode,
    interactionMode: row.interactionMode,
    bootstrap: parseJson(row.bootstrapJson),
    sourceProposedPlan: parseJson(row.sourceProposedPlanJson),
    actingUserId: row.actingUserId,
    desiredState: row.desiredState,
    phase: row.phase,
    deliveryCertainty: row.deliveryCertainty,
    runnable: row.runnable === 1,
    adoptedExecutionId: row.adoptedExecutionId,
    providerTurnId: row.providerTurnId,
    providerInstanceId: row.providerInstanceId,
    recoveryAttempts: row.recoveryAttempts,
    maximumRecoveryAttempts: row.maximumRecoveryAttempts,
    nextAttemptAt: row.nextAttemptAt,
    claimOwner: row.claimOwner,
    claimGeneration: row.claimGeneration,
    claimExpiresAt: row.claimExpiresAt,
    lastFailureType: row.lastFailureType,
    lastFailureDetail: row.lastFailureDetail,
    acceptedAt: row.acceptedAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    terminalAt: row.terminalAt,
    exhaustedAt: row.exhaustedAt,
    dismissedAt: row.dismissedAt,
  };
}

export interface AcceptDurableExecutionIntentInput {
  readonly event: TurnStartEvent;
  readonly message: ProjectionThreadMessage | null;
}

export interface DurableExecutionIntentRepositoryShape {
  readonly acceptFromEvent: (
    input: AcceptDurableExecutionIntentInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByWorkItemId: (input: {
    readonly workItemId: string;
  }) => Effect.Effect<Option.Option<DurableExecutionIntent>, ProjectionRepositoryError>;
  readonly listByThreadId: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<DurableExecutionIntent>, ProjectionRepositoryError>;
  readonly countVisibleByPhase: Effect.Effect<
    Readonly<Record<string, number>>,
    ProjectionRepositoryError
  >;
  readonly reconcileStartup: (input: {
    readonly at: string;
  }) => Effect.Effect<number, ProjectionRepositoryError>;
  readonly listRunnable: (input: {
    readonly now: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<DurableExecutionIntent>, ProjectionRepositoryError>;
  readonly nextRunnableAt: (input: {
    readonly now: string;
  }) => Effect.Effect<Option.Option<string>, ProjectionRepositoryError>;
  readonly claim: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly now: string;
    readonly expiresAt: string;
  }) => Effect.Effect<Option.Option<DurableExecutionIntent>, ProjectionRepositoryError>;
  readonly isClaimCurrent: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly now: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly renewClaim: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly expiresAt: string;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markProviderStarting: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly getBootstrapOperation: (input: {
    readonly workItemId: string;
  }) => Effect.Effect<Option.Option<DurableBootstrapOperation>, ProjectionRepositoryError>;
  readonly beginBootstrapStep: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly step: "worktree" | "setup";
    readonly at: string;
  }) => Effect.Effect<Option.Option<DurableBootstrapPhase>, ProjectionRepositoryError>;
  /** Marks the actual worktree creation side-effect boundary after validation. */
  readonly beginWorktreeCreation: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly acknowledgeBootstrapStep: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly step: "worktree" | "setup";
    readonly worktreePath?: string;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markBootstrapStepFailed: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly step: "worktree" | "setup";
    readonly phase: "failed" | "uncertain";
    readonly detail: string;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly deferClaim: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly at: string;
    /** A known earlier durable turn is ordinary queueing, not a failed recovery. */
    readonly restoreRecoveryAttempt?: boolean;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly beginRecoveryAttempt: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly at: string;
  }) => Effect.Effect<Option.Option<DurableExecutionIntent>, ProjectionRepositoryError>;
  readonly markAcknowledged: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly providerTurnId: string;
    readonly providerInstanceId: string | null;
    readonly adoptedExecutionId: string;
    readonly terminalAssociation?: boolean;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /**
   * Records a provider-acknowledged same-turn steer whose visible association
   * event still needs delivery. The provider side effect has already happened,
   * so the coordinator must retry only the association command.
   */
  readonly markAssociationPending: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly providerTurnId: string;
    readonly providerInstanceId: string | null;
    readonly adoptedExecutionId: string;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markCompletedFromHistory: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly providerTurnId: string | null;
    readonly completionKind?: "handled-command" | "history-completed";
    readonly providerInstanceId: string | null;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markOriginalDispatchFailed: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly failureType: string;
    readonly detail: string;
    readonly deliveryUncertain: boolean;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markRecoveryAttemptFailed: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly failureType: string;
    readonly detail: string;
    readonly nextAttemptAt: string | null;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly markFailedAttention: (input: {
    readonly workItemId: string;
    readonly owner: string;
    readonly generation: number;
    readonly failureType: string;
    readonly detail: string;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly stopThread: (input: {
    readonly threadId: ThreadId;
    readonly reason: string;
    readonly at: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly retryExhausted: (input: {
    readonly threadId: ThreadId;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly dismissExhausted: (input: {
    readonly threadId: ThreadId;
    readonly at: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  readonly observeSession: (input: {
    readonly threadId: ThreadId;
    readonly status:
      | "idle"
      | "starting"
      | "ready"
      | "running"
      | "error"
      | "interrupted"
      | "stopped";
    readonly providerTurnId: string | null;
    readonly error: string | null;
    readonly at: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly observeBlockingActivity: (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "approval.requested"
      | "approval.resolved"
      | "user-input.requested"
      | "user-input.resolved";
    readonly at: string;
    readonly requestId?: string;
    /** `message` questions remain visible but do not pause provider execution. */
    readonly responseMode?: "message";
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class DurableExecutionIntentRepository extends Context.Service<
  DurableExecutionIntentRepository,
  DurableExecutionIntentRepositoryShape
>()("t3/execution/DurableExecutionIntentRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readRows = (query: Effect.Effect<ReadonlyArray<DurableExecutionIntentRow>, SqlError>) =>
    query.pipe(
      Effect.map((rows) => rows.map(fromRow)),
      Effect.mapError((cause) => persistenceError("DurableExecutionIntentRepository.read", cause)),
    );

  const acceptFromEvent: DurableExecutionIntentRepositoryShape["acceptFromEvent"] = ({
    event,
    message,
  }) => {
    const commandId = event.commandId;
    if (commandId === null) {
      return Effect.fail(
        new PersistenceSqlError({
          operation: "DurableExecutionIntentRepository.acceptFromEvent",
          detail: "thread.turn-start-requested is missing commandId",
          correlation: { threadId: event.payload.threadId },
        }),
      );
    }
    if (message === null) {
      return Effect.fail(
        new PersistenceSqlError({
          operation: "DurableExecutionIntentRepository.acceptFromEvent",
          detail: `Accepted message '${event.payload.messageId}' is unavailable; refusing a partial acknowledgement.`,
          correlation: { threadId: event.payload.threadId },
        }),
      );
    }
    const actorUserId = message.sentByUserId ?? event.metadata.actorUserId ?? null;
    const bootstrap = event.payload.bootstrap;
    const resolvedWorkspace = bootstrap?.resolvedRequest?.workspace;
    const requiresWorktree =
      bootstrap?.prepareWorktree !== undefined || resolvedWorkspace?.mode === "new-worktree";
    const requiresSetup =
      bootstrap?.runSetupScript === true || resolvedWorkspace?.mode === "new-worktree";
    const initialWorkspacePath =
      bootstrap?.createThread?.worktreePath ??
      (resolvedWorkspace?.mode === "local" || resolvedWorkspace?.mode === "existing-worktree"
        ? resolvedWorkspace.path
        : (resolvedWorkspace?.intendedPath ?? null));
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ readonly workItemId: string }>`
          INSERT INTO projection_thread_execution_intents (
            work_item_id, thread_id, message_id, command_id, request_event_sequence,
            message_text, attachments_json, model_selection_json, runtime_mode,
            interaction_mode, bootstrap_json, source_proposed_plan_json, acting_user_id,
            desired_state, phase, delivery_certainty, runnable,
            adopted_execution_id, recovery_attempts, maximum_recovery_attempts, claim_generation,
            last_failure_type, last_failure_detail, accepted_at, updated_at, exhausted_at
          ) VALUES (
            ${commandId}, ${event.payload.threadId}, ${event.payload.messageId}, ${commandId},
            ${event.sequence}, ${message.text}, ${encodeJson(message.attachments ?? [])},
            ${event.payload.modelSelection === undefined ? null : encodeJson(event.payload.modelSelection)},
            ${event.payload.runtimeMode}, ${event.payload.interactionMode},
            ${event.payload.bootstrap === undefined ? null : encodeJson(event.payload.bootstrap)},
            ${event.payload.sourceProposedPlan === undefined ? null : encodeJson(event.payload.sourceProposedPlan)},
            ${actorUserId}, 'running', 'queued', 'never-delivered', 1,
            ${commandId}, 0, 10, 0, NULL, NULL,
            ${event.occurredAt}, ${event.occurredAt}, NULL
          )
          ON CONFLICT(command_id) DO NOTHING
          RETURNING work_item_id AS "workItemId"
        `;
          if (inserted.length === 0) return;
          yield* sql`
          UPDATE projection_thread_execution_intents
          SET dismissed_at = COALESCE(dismissed_at, ${event.occurredAt}),
              updated_at = ${event.occurredAt}
          WHERE thread_id = ${event.payload.threadId}
            AND work_item_id <> ${commandId}
            AND phase = 'recovery-exhausted'
            AND dismissed_at IS NULL
        `;
          if (event.payload.bootstrap !== undefined) {
            yield* sql`
            INSERT INTO thread_execution_bootstrap_operations (
              work_item_id, thread_id, worktree_phase, worktree_path,
              setup_phase, setup_terminal_id, updated_at
            ) VALUES (
              ${commandId}, ${event.payload.threadId},
              ${requiresWorktree ? "pending" : "not-required"},
              ${initialWorkspacePath},
              ${requiresSetup ? "pending" : "not-required"},
              ${`setup-${commandId}`}, ${event.occurredAt}
            )
            ON CONFLICT(work_item_id) DO NOTHING
          `;
          }
          yield* sql`
          INSERT INTO session_recovery_state (
            thread_id, desired_state, reason, last_execution_id, attempts,
            last_attempt_at, next_attempt_at, recovered_at, gave_up_at, updated_at
          ) VALUES (
            ${event.payload.threadId}, 'running', 'durable-intent-accepted', ${commandId},
            0, NULL, NULL, NULL, NULL, ${event.occurredAt}
          )
          ON CONFLICT(thread_id) DO UPDATE SET
            desired_state = 'running',
            reason = 'durable-intent-accepted',
            last_execution_id = excluded.last_execution_id,
            attempts = CASE
              WHEN session_recovery_state.last_execution_id IS excluded.last_execution_id
              THEN session_recovery_state.attempts ELSE 0
            END,
            last_attempt_at = CASE
              WHEN session_recovery_state.last_execution_id IS excluded.last_execution_id
              THEN session_recovery_state.last_attempt_at ELSE NULL
            END,
            next_attempt_at = CASE
              WHEN session_recovery_state.last_execution_id IS excluded.last_execution_id
              THEN session_recovery_state.next_attempt_at ELSE NULL
            END,
            recovered_at = NULL,
            gave_up_at = NULL,
            updated_at = excluded.updated_at
        `;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError(
            "DurableExecutionIntentRepository.acceptFromEvent",
            cause,
            event.payload.threadId,
          ),
        ),
      );
  };

  const getByWorkItemId: DurableExecutionIntentRepositoryShape["getByWorkItemId"] = ({
    workItemId,
  }) =>
    readRows(sql<DurableExecutionIntentRow>`
      SELECT ${sql.literal(SELECT_COLUMNS)}
      FROM projection_thread_execution_intents
      WHERE work_item_id = ${workItemId}
      LIMIT 1
    `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const listByThreadId: DurableExecutionIntentRepositoryShape["listByThreadId"] = ({ threadId }) =>
    readRows(sql<DurableExecutionIntentRow>`
      SELECT ${sql.literal(SELECT_COLUMNS)}
      FROM projection_thread_execution_intents
      WHERE thread_id = ${threadId}
      ORDER BY request_event_sequence ASC, accepted_at ASC, work_item_id ASC
    `);

  const countVisibleByPhase: DurableExecutionIntentRepositoryShape["countVisibleByPhase"] = sql<{
    readonly phase: string;
    readonly count: number;
  }>`
    SELECT phase, COUNT(*) AS count
    FROM projection_thread_execution_intents
    WHERE desired_state = 'running'
       OR (phase = 'recovery-exhausted' AND dismissed_at IS NULL)
    GROUP BY phase
  `.pipe(
    Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.phase, row.count]))),
    Effect.mapError((cause) =>
      persistenceError("DurableExecutionIntentRepository.countVisibleByPhase", cause),
    ),
  );

  const reconcileStartup: DurableExecutionIntentRepositoryShape["reconcileStartup"] = ({ at }) =>
    sql`
      UPDATE projection_thread_execution_intents
      SET phase = CASE
            WHEN last_failure_type = 'turn-association-pending' THEN 'retry-wait'
            ELSE 'recovering'
          END,
          delivery_certainty = CASE
            WHEN phase IN ('starting', 'running') AND delivery_certainty = 'never-delivered'
            THEN 'uncertain'
            ELSE delivery_certainty
          END,
          next_attempt_at = ${at},
          claim_owner = NULL,
          claim_generation = claim_generation + 1,
          claim_expires_at = NULL,
          last_failure_type = CASE
            WHEN last_failure_type = 'turn-association-pending' THEN last_failure_type
            ELSE 'server-authority-restarted'
          END,
          last_failure_detail = CASE
            WHEN last_failure_type = 'turn-association-pending' THEN last_failure_detail
            ELSE 'Server authority restarted before terminal provider evidence.'
          END,
          updated_at = ${at}
      WHERE desired_state = 'running'
        AND runnable = 1
        AND (
          phase IN ('preparing', 'starting', 'running')
          OR claim_owner IS NOT NULL
        )
      RETURNING work_item_id
    `.pipe(
      Effect.flatMap((rows) =>
        // T3-CUSTOM(expbkt3): the supervisor can retain a persisted
        // waiting-for-input snapshot across an upgrade or reconnect. Repair it
        // from the request ledger before any coordinator work starts; an async
        // message-mode question is visible but never a durable blocker.
        sql`
          WITH request_lifecycle AS (
            SELECT
              thread_id,
              kind,
              turn_id,
              json_extract(payload_json, '$.responseMode') AS response_mode,
              ROW_NUMBER() OVER (
                PARTITION BY thread_id, json_extract(payload_json, '$.requestId')
                ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                         sequence DESC, created_at DESC, activity_id DESC
              ) AS request_order
            FROM projection_thread_activities
            WHERE (
              kind IN ('approval.requested', 'approval.resolved', 'user-input.requested', 'user-input.resolved')
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
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
            -- Only threads this statement can update: keeps the read on the
            -- (thread_id, kind) index instead of scanning every activity.
            AND thread_id IN (
              SELECT thread_id FROM projection_thread_execution_intents
              WHERE desired_state = 'running'
                AND phase IN ('waiting-for-approval', 'waiting-for-input')
            )
          ), blocking_threads AS (
            SELECT DISTINCT thread_id
            FROM request_lifecycle
            WHERE request_order = 1
              AND (
                kind = 'approval.requested'
                OR (kind = 'user-input.requested' AND COALESCE(response_mode, '') <> 'message')
              )
              AND (
                turn_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM projection_turns AS turn
                  WHERE turn.thread_id = request_lifecycle.thread_id
                    AND turn.turn_id = request_lifecycle.turn_id
                    AND turn.state IN ('completed', 'interrupted', 'error')
                )
              )
          )
          UPDATE projection_thread_execution_intents
          SET phase = 'recovering', runnable = 1, next_attempt_at = ${at}, updated_at = ${at}
          WHERE desired_state = 'running'
            AND phase IN ('waiting-for-approval', 'waiting-for-input')
            AND thread_id NOT IN (SELECT thread_id FROM blocking_threads)
        `.pipe(Effect.as(rows.length)),
      ),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.reconcileStartup", cause),
      ),
    );

  const listRunnable: DurableExecutionIntentRepositoryShape["listRunnable"] = ({ now, limit }) =>
    readRows(sql<DurableExecutionIntentRow>`
      SELECT ${sql.literal(SELECT_COLUMNS)}
      FROM projection_thread_execution_intents
      WHERE desired_state = 'running'
        AND runnable = 1
        AND dismissed_at IS NULL
        AND recovery_attempts < maximum_recovery_attempts
        AND phase IN ('queued', 'preparing', 'starting', 'recovering', 'retry-wait')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_execution_intents AS prior_work
          WHERE prior_work.thread_id = projection_thread_execution_intents.thread_id
            AND prior_work.request_event_sequence < projection_thread_execution_intents.request_event_sequence
            AND prior_work.desired_state = 'running'
            AND prior_work.phase IN (
              'queued', 'preparing', 'starting', 'waiting-for-approval',
              'waiting-for-input', 'recovering', 'retry-wait'
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_execution_intents AS active_claim
          WHERE active_claim.thread_id = projection_thread_execution_intents.thread_id
            AND active_claim.work_item_id <> projection_thread_execution_intents.work_item_id
            AND active_claim.claim_owner IS NOT NULL
            AND active_claim.claim_expires_at > ${now}
        )
      ORDER BY
        COALESCE((
          SELECT priority FROM projection_threads AS priority_thread
          WHERE priority_thread.thread_id = projection_thread_execution_intents.thread_id
        ), 4) ASC,
        CASE phase
          WHEN 'starting' THEN 0
          WHEN 'recovering' THEN 1
          WHEN 'preparing' THEN 2
          WHEN 'queued' THEN 3
          ELSE 4
        END,
        request_event_sequence ASC,
        accepted_at ASC
      LIMIT ${Math.max(1, Math.floor(limit))}
    `);

  const nextRunnableAt: DurableExecutionIntentRepositoryShape["nextRunnableAt"] = ({ now }) =>
    sql<{ readonly nextAt: string | null }>`
      SELECT MIN(
        CASE
          WHEN EXISTS (
            SELECT 1 FROM projection_thread_execution_intents AS active_claim
            WHERE active_claim.thread_id = candidate.thread_id
              AND active_claim.claim_owner IS NOT NULL
              AND active_claim.claim_expires_at > ${now}
          ) THEN (
            SELECT MIN(active_claim.claim_expires_at)
            FROM projection_thread_execution_intents AS active_claim
            WHERE active_claim.thread_id = candidate.thread_id
              AND active_claim.claim_owner IS NOT NULL
              AND active_claim.claim_expires_at > ${now}
          )
          ELSE COALESCE(candidate.next_attempt_at, ${now})
        END
      ) AS "nextAt"
      FROM projection_thread_execution_intents AS candidate
      WHERE desired_state = 'running'
        AND runnable = 1
        AND dismissed_at IS NULL
        AND recovery_attempts < maximum_recovery_attempts
        AND phase IN ('queued', 'preparing', 'starting', 'recovering', 'retry-wait')
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_execution_intents AS prior_work
          WHERE prior_work.thread_id = candidate.thread_id
            AND prior_work.request_event_sequence < candidate.request_event_sequence
            AND prior_work.desired_state = 'running'
            AND prior_work.phase IN (
              'queued', 'preparing', 'starting', 'waiting-for-approval',
              'waiting-for-input', 'recovering', 'retry-wait'
            )
        )
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.nextAt)),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.nextRunnableAt", cause),
      ),
    );

  const claim: DurableExecutionIntentRepositoryShape["claim"] = ({
    workItemId,
    owner,
    now,
    expiresAt,
  }) =>
    readRows(sql<DurableExecutionIntentRow>`
      UPDATE projection_thread_execution_intents AS candidate
      SET claim_owner = ${owner},
          claim_generation = claim_generation + 1,
          claim_expires_at = ${expiresAt},
          phase = CASE WHEN phase = 'queued' THEN 'starting' ELSE 'recovering' END,
          updated_at = ${now}
      WHERE work_item_id = ${workItemId}
        AND desired_state = 'running'
        AND runnable = 1
        AND dismissed_at IS NULL
        AND recovery_attempts < maximum_recovery_attempts
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        AND (claim_owner IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ${now})
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_execution_intents AS prior_work
          WHERE prior_work.thread_id = candidate.thread_id
            AND prior_work.request_event_sequence < candidate.request_event_sequence
            AND prior_work.desired_state = 'running'
            AND prior_work.phase IN (
              'queued', 'preparing', 'starting', 'waiting-for-approval',
              'waiting-for-input', 'recovering', 'retry-wait'
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM projection_thread_execution_intents AS active
          WHERE active.thread_id = candidate.thread_id
            AND active.work_item_id <> candidate.work_item_id
            AND active.claim_owner IS NOT NULL
            AND active.claim_expires_at > ${now}
        )
      RETURNING ${sql.literal(SELECT_COLUMNS)}
    `).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const isClaimCurrent: DurableExecutionIntentRepositoryShape["isClaimCurrent"] = ({
    workItemId,
    owner,
    generation,
    now,
  }) =>
    sql<{ readonly current: number }>`
      SELECT EXISTS(
        SELECT 1
        FROM projection_thread_execution_intents
        WHERE work_item_id = ${workItemId}
          AND desired_state = 'running'
          AND runnable = 1
          AND claim_owner = ${owner}
          AND claim_generation = ${generation}
          AND claim_expires_at > ${now}
      ) AS current
    `.pipe(
      Effect.map((rows) => rows[0]?.current === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.isClaimCurrent", cause),
      ),
    );

  const renewClaim: DurableExecutionIntentRepositoryShape["renewClaim"] = ({
    workItemId,
    owner,
    generation,
    expiresAt,
    at,
  }) =>
    sql<{ readonly workItemId: string }>`
      UPDATE projection_thread_execution_intents
      SET claim_expires_at = ${expiresAt}, updated_at = ${at}
      WHERE work_item_id = ${workItemId}
        AND desired_state = 'running'
        AND claim_owner = ${owner}
        AND claim_generation = ${generation}
      RETURNING work_item_id AS "workItemId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.renewClaim", cause),
      ),
    );

  const markProviderStarting: DurableExecutionIntentRepositoryShape["markProviderStarting"] = ({
    workItemId,
    owner,
    generation,
    at,
  }) =>
    sql<{ readonly workItemId: string }>`
      UPDATE projection_thread_execution_intents
      SET phase = 'starting', updated_at = ${at}
      WHERE work_item_id = ${workItemId}
        AND desired_state = 'running'
        AND runnable = 1
        AND claim_owner = ${owner}
        AND claim_generation = ${generation}
      RETURNING work_item_id AS "workItemId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.markProviderStarting", cause),
      ),
    );

  const getBootstrapOperation: DurableExecutionIntentRepositoryShape["getBootstrapOperation"] = ({
    workItemId,
  }) =>
    sql<DurableBootstrapOperation>`
      SELECT work_item_id AS "workItemId", thread_id AS "threadId",
             worktree_phase AS "worktreePhase", worktree_path AS "worktreePath",
             setup_phase AS "setupPhase", setup_terminal_id AS "setupTerminalId",
             last_failure_detail AS "lastFailureDetail", updated_at AS "updatedAt"
      FROM thread_execution_bootstrap_operations
      WHERE work_item_id = ${workItemId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.getBootstrapOperation", cause),
      ),
    );

  const beginBootstrapStep: DurableExecutionIntentRepositoryShape["beginBootstrapStep"] = ({
    workItemId,
    owner,
    generation,
    step,
    at,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{
            readonly worktreePhase: DurableBootstrapPhase;
            readonly setupPhase: DurableBootstrapPhase;
          }>`
          SELECT worktree_phase AS "worktreePhase", setup_phase AS "setupPhase"
          FROM thread_execution_bootstrap_operations AS bootstrap
          WHERE bootstrap.work_item_id = ${workItemId}
            AND EXISTS (
              SELECT 1 FROM projection_thread_execution_intents AS intent
              WHERE intent.work_item_id = bootstrap.work_item_id
                AND intent.desired_state = 'running'
                AND intent.claim_owner = ${owner}
                AND intent.claim_generation = ${generation}
            )
          LIMIT 1
        `;
          const row = current[0];
          if (row === undefined) return Option.none<DurableBootstrapPhase>();
          const phase = step === "worktree" ? row.worktreePhase : row.setupPhase;
          if (phase !== "pending") return Option.some(phase);
          if (step === "worktree") {
            // T3-CUSTOM(expbkt3): validation and fetches are replay-safe. Do
            // not turn them into a crash uncertainty boundary; only the actual
            // createWorktree call is non-idempotent.
            return Option.some<DurableBootstrapPhase>("pending");
          } else {
            yield* sql`
            UPDATE thread_execution_bootstrap_operations
            SET setup_phase = 'running', updated_at = ${at}
            WHERE work_item_id = ${workItemId} AND setup_phase = 'pending'
          `;
          }
          yield* sql`
          UPDATE projection_thread_execution_intents
          SET phase = 'preparing', updated_at = ${at}
          WHERE work_item_id = ${workItemId}
            AND claim_owner = ${owner}
            AND claim_generation = ${generation}
        `;
          return Option.some<DurableBootstrapPhase>("pending");
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.beginBootstrapStep", cause),
        ),
      );

  const acknowledgeBootstrapStep: DurableExecutionIntentRepositoryShape["acknowledgeBootstrapStep"] =
    ({ workItemId, owner, generation, step, worktreePath, at }) => {
      const update =
        step === "worktree"
          ? sql`
              UPDATE thread_execution_bootstrap_operations AS bootstrap
              SET worktree_phase = 'acknowledged',
                  worktree_path = COALESCE(${worktreePath ?? null}, worktree_path),
                  updated_at = ${at}
              WHERE work_item_id = ${workItemId}
                AND worktree_phase IN ('pending', 'running')
                AND EXISTS (
                  SELECT 1 FROM projection_thread_execution_intents AS intent
                  WHERE intent.work_item_id = bootstrap.work_item_id
                    AND intent.desired_state = 'running'
                    AND intent.claim_owner = ${owner}
                    AND intent.claim_generation = ${generation}
                )
              RETURNING work_item_id
            `
          : sql`
              UPDATE thread_execution_bootstrap_operations AS bootstrap
              SET setup_phase = 'acknowledged', updated_at = ${at}
              WHERE work_item_id = ${workItemId}
                AND setup_phase IN ('pending', 'running')
                AND EXISTS (
                  SELECT 1 FROM projection_thread_execution_intents AS intent
                  WHERE intent.work_item_id = bootstrap.work_item_id
                    AND intent.desired_state = 'running'
                    AND intent.claim_owner = ${owner}
                    AND intent.claim_generation = ${generation}
                )
              RETURNING work_item_id
            `;
      return update.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.acknowledgeBootstrapStep", cause),
        ),
      );
    };

  const beginWorktreeCreation: DurableExecutionIntentRepositoryShape["beginWorktreeCreation"] = ({
    workItemId,
    owner,
    generation,
    at,
  }) =>
    sql<{ readonly workItemId: string }>`
      UPDATE thread_execution_bootstrap_operations AS bootstrap
      SET worktree_phase = 'running', updated_at = ${at}
      WHERE work_item_id = ${workItemId}
        AND worktree_phase = 'pending'
        AND EXISTS (
          SELECT 1 FROM projection_thread_execution_intents AS intent
          WHERE intent.work_item_id = bootstrap.work_item_id
            AND intent.desired_state = 'running'
            AND intent.claim_owner = ${owner}
            AND intent.claim_generation = ${generation}
        )
      RETURNING work_item_id AS "workItemId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.beginWorktreeCreation", cause),
      ),
    );

  const markBootstrapStepFailed: DurableExecutionIntentRepositoryShape["markBootstrapStepFailed"] =
    ({ workItemId, owner, generation, step, phase, detail, at }) => {
      const update =
        step === "worktree"
          ? sql`
              UPDATE thread_execution_bootstrap_operations AS bootstrap
              SET worktree_phase = ${phase}, last_failure_detail = ${detail}, updated_at = ${at}
              WHERE work_item_id = ${workItemId}
                AND EXISTS (
                  SELECT 1 FROM projection_thread_execution_intents AS intent
                  WHERE intent.work_item_id = bootstrap.work_item_id
                    AND intent.desired_state = 'running'
                    AND intent.claim_owner = ${owner}
                    AND intent.claim_generation = ${generation}
                )
              RETURNING work_item_id
            `
          : sql`
              UPDATE thread_execution_bootstrap_operations AS bootstrap
              SET setup_phase = ${phase}, last_failure_detail = ${detail}, updated_at = ${at}
              WHERE work_item_id = ${workItemId}
                AND EXISTS (
                  SELECT 1 FROM projection_thread_execution_intents AS intent
                  WHERE intent.work_item_id = bootstrap.work_item_id
                    AND intent.desired_state = 'running'
                    AND intent.claim_owner = ${owner}
                    AND intent.claim_generation = ${generation}
                )
              RETURNING work_item_id
            `;
      return update.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.markBootstrapStepFailed", cause),
        ),
      );
    };

  const beginRecoveryAttempt: DurableExecutionIntentRepositoryShape["beginRecoveryAttempt"] = ({
    workItemId,
    owner,
    generation,
    at,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<DurableExecutionIntentRow>`
          UPDATE projection_thread_execution_intents
          SET recovery_attempts = recovery_attempts + 1,
              phase = 'recovering',
              next_attempt_at = NULL,
              updated_at = ${at}
          WHERE work_item_id = ${workItemId}
            AND desired_state = 'running'
            AND claim_owner = ${owner}
            AND claim_generation = ${generation}
            AND recovery_attempts < maximum_recovery_attempts
          RETURNING ${sql.literal(SELECT_COLUMNS)}
        `;
          const row = rows[0];
          if (row === undefined) return Option.none<DurableExecutionIntent>();
          yield* sql`
          INSERT INTO thread_execution_recovery_attempts (
            work_item_id, thread_id, attempt, claim_owner, claim_generation,
            started_at, outcome, provider_instance_id, provider_turn_id
          ) VALUES (
            ${row.workItemId}, ${row.threadId}, ${row.recoveryAttempts}, ${owner}, ${generation},
            ${at}, 'started', ${row.providerInstanceId}, ${row.providerTurnId}
          )
        `;
          yield* sql`
          UPDATE session_recovery_state
          SET desired_state = 'running', reason = 'durable-recovery-attempt',
              attempts = ${row.recoveryAttempts}, last_attempt_at = ${at},
              next_attempt_at = NULL, recovered_at = NULL, gave_up_at = NULL,
              updated_at = ${at}
          WHERE thread_id = ${row.threadId}
        `;
          return Option.some(fromRow(row));
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.beginRecoveryAttempt", cause),
        ),
      );

  const deferClaim: DurableExecutionIntentRepositoryShape["deferClaim"] = ({
    workItemId,
    owner,
    generation,
    at,
    restoreRecoveryAttempt = false,
  }) =>
    sql<{ readonly workItemId: string }>`
      UPDATE projection_thread_execution_intents
      -- T3-CUSTOM(expbkt3): a known earlier provider turn only defers this
      -- recovery claim; it must retain guarded-continuation certainty.
      SET phase = CASE WHEN ${restoreRecoveryAttempt ? 1 : 0} THEN 'recovering' ELSE 'queued' END,
          runnable = 0, next_attempt_at = NULL,
          recovery_attempts = CASE
            WHEN ${restoreRecoveryAttempt ? 1 : 0} THEN MAX(0, recovery_attempts - 1)
            ELSE recovery_attempts
          END,
          claim_owner = NULL, claim_expires_at = NULL, updated_at = ${at}
      WHERE work_item_id = ${workItemId}
        AND desired_state = 'running'
        AND claim_owner = ${owner}
        AND claim_generation = ${generation}
      RETURNING work_item_id AS "workItemId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.deferClaim", cause),
      ),
    );

  const markAcknowledged: DurableExecutionIntentRepositoryShape["markAcknowledged"] = ({
    workItemId,
    owner,
    generation,
    providerTurnId,
    providerInstanceId,
    adoptedExecutionId,
    terminalAssociation = false,
    at,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // T3-CUSTOM(expbkt3): the terminal session fence is evaluated in
          // this acknowledgement transaction, closing the completion race.
          const rows = yield* sql<{
            readonly threadId: ThreadId;
            readonly attempt: number;
            readonly desiredState: string;
          }>`
          UPDATE projection_thread_execution_intents
          SET desired_state = CASE
                WHEN ${terminalAssociation ? 1 : 0} = 1
                 AND EXISTS (
                   SELECT 1 FROM projection_thread_sessions AS session
                   WHERE session.thread_id = projection_thread_execution_intents.thread_id
                     AND session.status IN ('ready', 'stopped', 'error', 'interrupted')
                     AND session.active_turn_id IS NULL
                 )
                THEN 'stopped' ELSE desired_state
              END,
              phase = 'running',
              runnable = CASE
                WHEN ${terminalAssociation ? 1 : 0} = 1
                 AND EXISTS (
                   SELECT 1 FROM projection_thread_sessions AS session
                   WHERE session.thread_id = projection_thread_execution_intents.thread_id
                     AND session.status IN ('ready', 'stopped', 'error', 'interrupted')
                     AND session.active_turn_id IS NULL
                 )
                THEN 0 ELSE runnable
              END,
              delivery_certainty = CASE
                WHEN ${terminalAssociation ? 1 : 0} = 1
                 AND EXISTS (
                   SELECT 1 FROM projection_thread_sessions AS session
                   WHERE session.thread_id = projection_thread_execution_intents.thread_id
                     AND session.status IN ('ready', 'stopped', 'error', 'interrupted')
                     AND session.active_turn_id IS NULL
                 )
                THEN 'completed' ELSE 'provider-acknowledged'
              END,
              provider_turn_id = ${providerTurnId},
              provider_instance_id = COALESCE(${providerInstanceId}, provider_instance_id),
              adopted_execution_id = ${adoptedExecutionId},
              started_at = COALESCE(started_at, ${at}),
              next_attempt_at = NULL,
              claim_owner = NULL,
              claim_expires_at = NULL,
              last_failure_type = NULL,
              last_failure_detail = NULL,
              terminal_at = CASE
                WHEN ${terminalAssociation ? 1 : 0} = 1
                 AND EXISTS (
                   SELECT 1 FROM projection_thread_sessions AS session
                   WHERE session.thread_id = projection_thread_execution_intents.thread_id
                     AND session.status IN ('ready', 'stopped', 'error', 'interrupted')
                     AND session.active_turn_id IS NULL
                 )
                THEN ${at} ELSE terminal_at
              END,
              updated_at = ${at}
          WHERE work_item_id = ${workItemId}
            AND desired_state = 'running'
            AND claim_owner = ${owner}
            AND claim_generation = ${generation}
          RETURNING thread_id AS "threadId", recovery_attempts AS attempt, desired_state AS "desiredState"
        `;
          const row = rows[0];
          if (row === undefined) return false;
          if (row.desiredState === "stopped") {
            const remaining = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM projection_thread_execution_intents
              WHERE thread_id = ${row.threadId} AND desired_state = 'running'
            `;
            if ((remaining[0]?.count ?? 0) === 0) {
              yield* sql`
                UPDATE session_recovery_state
                SET desired_state = 'stopped', reason = 'turn-completed',
                    next_attempt_at = NULL, updated_at = ${at}
                WHERE thread_id = ${row.threadId}
              `;
            }
          }
          if (row.attempt > 0) {
            yield* sql`
            UPDATE thread_execution_recovery_attempts
            SET completed_at = ${at}, outcome = 'provider-acknowledged',
                provider_instance_id = COALESCE(${providerInstanceId}, provider_instance_id),
                provider_turn_id = ${providerTurnId}
            WHERE work_item_id = ${workItemId}
              AND attempt = ${row.attempt}
              AND claim_generation = ${generation}
          `;
            yield* sql`
            UPDATE session_recovery_state
            SET desired_state = 'running', reason = 'durable-recovery-succeeded',
                attempts = ${row.attempt}, next_attempt_at = NULL,
                recovered_at = ${at}, gave_up_at = NULL, updated_at = ${at}
            WHERE thread_id = ${row.threadId}
          `;
          }
          return true;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.markAcknowledged", cause),
        ),
      );

  const markAssociationPending: DurableExecutionIntentRepositoryShape["markAssociationPending"] = ({
    workItemId,
    owner,
    generation,
    providerTurnId,
    providerInstanceId,
    adoptedExecutionId,
    at,
  }) =>
    sql<{ readonly workItemId: string }>`
      UPDATE projection_thread_execution_intents
      SET phase = 'retry-wait',
          runnable = 1,
          delivery_certainty = 'provider-acknowledged',
          provider_turn_id = ${providerTurnId},
          provider_instance_id = COALESCE(${providerInstanceId}, provider_instance_id),
          adopted_execution_id = ${adoptedExecutionId},
          started_at = COALESCE(started_at, ${at}),
          next_attempt_at = ${at},
          claim_owner = NULL,
          claim_expires_at = NULL,
          last_failure_type = 'turn-association-pending',
          last_failure_detail = 'Provider accepted the steer; retrying its durable turn association.',
          updated_at = ${at}
      WHERE work_item_id = ${workItemId}
        AND desired_state = 'running'
        AND runnable = 1
        AND claim_owner = ${owner}
        AND claim_generation = ${generation}
      RETURNING work_item_id AS "workItemId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.markAssociationPending", cause),
      ),
    );

  const markCompletedFromHistory: DurableExecutionIntentRepositoryShape["markCompletedFromHistory"] =
    ({
      workItemId,
      owner,
      generation,
      providerTurnId,
      providerInstanceId,
      completionKind = "history-completed",
      at,
    }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{ readonly threadId: ThreadId; readonly attempt: number }>`
            UPDATE projection_thread_execution_intents
            SET desired_state = 'stopped', phase = 'running', runnable = 0,
                delivery_certainty = 'completed', provider_turn_id = ${providerTurnId},
                provider_instance_id = COALESCE(${providerInstanceId}, provider_instance_id),
                started_at = COALESCE(started_at, ${at}), terminal_at = ${at},
                next_attempt_at = NULL, claim_owner = NULL, claim_expires_at = NULL,
                last_failure_type = NULL, last_failure_detail = NULL, updated_at = ${at}
            WHERE work_item_id = ${workItemId}
              AND desired_state = 'running'
              AND claim_owner = ${owner}
              AND claim_generation = ${generation}
            RETURNING thread_id AS "threadId", recovery_attempts AS attempt
          `;
            const row = rows[0];
            if (row === undefined) return false;
            if (row.attempt > 0) {
              yield* sql`
              UPDATE thread_execution_recovery_attempts
              SET completed_at = ${at}, outcome = ${completionKind},
                  provider_instance_id = COALESCE(${providerInstanceId}, provider_instance_id),
                  provider_turn_id = ${providerTurnId}
              WHERE work_item_id = ${workItemId}
                AND attempt = ${row.attempt}
                AND claim_generation = ${generation}
            `;
            }
            yield* sql`
            UPDATE projection_thread_execution_intents
            SET runnable = 1, next_attempt_at = ${at}, updated_at = ${at}
            WHERE work_item_id = (
              SELECT work_item_id FROM projection_thread_execution_intents
              WHERE thread_id = ${row.threadId} AND desired_state = 'running'
                AND phase IN ('queued', 'recovering') AND runnable = 0
              ORDER BY request_event_sequence ASC LIMIT 1
            )
          `;
            const remaining = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM projection_thread_execution_intents
            WHERE thread_id = ${row.threadId} AND desired_state = 'running'
          `;
            if ((remaining[0]?.count ?? 0) === 0) {
              yield* sql`
              UPDATE session_recovery_state
              SET desired_state = 'stopped', reason = 'turn-completed', next_attempt_at = NULL,
                  attempts = ${row.attempt}, recovered_at = ${at}, updated_at = ${at}
              WHERE thread_id = ${row.threadId}
            `;
            }
            return true;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("DurableExecutionIntentRepository.markCompletedFromHistory", cause),
          ),
        );

  const markOriginalDispatchFailed: DurableExecutionIntentRepositoryShape["markOriginalDispatchFailed"] =
    ({ workItemId, owner, generation, failureType, detail, deliveryUncertain, at }) =>
      // T3-CUSTOM(expbkt3): an acknowledged steer cannot fall back to ordinary
      // provider recovery when association persistence is interrupted.
      sql<{ readonly workItemId: string }>`
      UPDATE projection_thread_execution_intents
      SET phase = CASE
            WHEN last_failure_type = 'turn-association-pending' THEN 'retry-wait'
            ELSE 'recovering'
          END,
            delivery_certainty = CASE
              WHEN last_failure_type = 'turn-association-pending' THEN 'provider-acknowledged'
              WHEN ${deliveryUncertain ? 1 : 0} THEN 'uncertain' ELSE delivery_certainty
            END,
            next_attempt_at = ${at},
            claim_owner = NULL, claim_expires_at = NULL,
            last_failure_type = CASE
              WHEN last_failure_type = 'turn-association-pending' THEN last_failure_type
              ELSE ${failureType}
            END,
            last_failure_detail = CASE
              WHEN last_failure_type = 'turn-association-pending' THEN last_failure_detail
              ELSE ${detail}
            END,
            updated_at = ${at}
        WHERE work_item_id = ${workItemId}
          AND desired_state = 'running'
          AND claim_owner = ${owner}
          AND claim_generation = ${generation}
        RETURNING work_item_id AS "workItemId"
      `.pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.markOriginalDispatchFailed", cause),
        ),
      );

  const markRecoveryAttemptFailed: DurableExecutionIntentRepositoryShape["markRecoveryAttemptFailed"] =
    ({ workItemId, owner, generation, failureType, detail, nextAttemptAt, at }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly threadId: ThreadId;
              readonly attempt: number;
              readonly maximumAttempts: number;
            }>`
            SELECT thread_id AS "threadId", recovery_attempts AS attempt,
                   maximum_recovery_attempts AS "maximumAttempts"
            FROM projection_thread_execution_intents
            WHERE work_item_id = ${workItemId}
              AND desired_state = 'running'
              AND claim_owner = ${owner}
              AND claim_generation = ${generation}
          `;
            const current = rows[0];
            if (current === undefined) return false;
            const exhausted = current.attempt >= current.maximumAttempts;
            yield* sql`
            UPDATE projection_thread_execution_intents
            SET desired_state = ${exhausted ? "stopped" : "running"},
                phase = ${exhausted ? "recovery-exhausted" : "retry-wait"},
                runnable = ${exhausted ? 0 : 1},
                next_attempt_at = ${exhausted ? null : nextAttemptAt},
                claim_owner = NULL,
                claim_expires_at = NULL,
                last_failure_type = ${failureType},
                last_failure_detail = ${detail},
                exhausted_at = ${exhausted ? at : null},
                terminal_at = ${exhausted ? at : null},
                updated_at = ${at}
            WHERE work_item_id = ${workItemId}
              AND claim_owner = ${owner}
              AND claim_generation = ${generation}
          `;
            yield* sql`
            UPDATE thread_execution_recovery_attempts
            SET completed_at = ${at}, outcome = ${exhausted ? "exhausted" : "failed"},
                failure_type = ${failureType}, failure_detail = ${detail}
            WHERE work_item_id = ${workItemId}
              AND attempt = ${current.attempt}
              AND claim_generation = ${generation}
          `;
            yield* sql`
            UPDATE session_recovery_state
            SET desired_state = ${exhausted ? "stopped" : "running"},
                reason = ${failureType}, attempts = ${current.attempt},
                last_attempt_at = ${at},
                next_attempt_at = ${exhausted ? null : nextAttemptAt},
                recovered_at = NULL, gave_up_at = ${exhausted ? at : null},
                updated_at = ${at}
            WHERE thread_id = ${current.threadId}
          `;
            return true;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            persistenceError("DurableExecutionIntentRepository.markRecoveryAttemptFailed", cause),
          ),
        );

  const markFailedAttention: DurableExecutionIntentRepositoryShape["markFailedAttention"] = ({
    workItemId,
    owner,
    generation,
    failureType,
    detail,
    at,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly threadId: ThreadId; readonly attempt: number }>`
          UPDATE projection_thread_execution_intents
          SET desired_state = 'stopped', phase = 'recovery-exhausted', runnable = 0,
              next_attempt_at = NULL, claim_owner = NULL, claim_expires_at = NULL,
              last_failure_type = ${failureType}, last_failure_detail = ${detail},
              exhausted_at = ${at}, terminal_at = ${at}, updated_at = ${at}
          WHERE work_item_id = ${workItemId}
            AND desired_state = 'running'
            AND claim_owner = ${owner}
            AND claim_generation = ${generation}
          RETURNING thread_id AS "threadId", recovery_attempts AS attempt
        `;
          const row = rows[0];
          if (row === undefined) return false;
          if (row.attempt > 0) {
            yield* sql`
            UPDATE thread_execution_recovery_attempts
            SET completed_at = ${at}, outcome = 'failed-attention',
                failure_type = ${failureType}, failure_detail = ${detail}
            WHERE work_item_id = ${workItemId}
              AND attempt = ${row.attempt}
              AND claim_generation = ${generation}
          `;
          }
          yield* sql`
          UPDATE session_recovery_state
          SET desired_state = 'stopped', reason = ${failureType}, next_attempt_at = NULL,
              attempts = ${row.attempt}, last_attempt_at = ${at},
              gave_up_at = ${at}, updated_at = ${at}
          WHERE thread_id = ${row.threadId}
        `;
          return true;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.markFailedAttention", cause),
        ),
      );

  const stopThread: DurableExecutionIntentRepositoryShape["stopThread"] = ({
    threadId,
    reason,
    at,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // T3-CUSTOM(expbkt3): an accepted steer still needs its durable
          // association after a stop races the acknowledgement. Keep that
          // marker runnable so the association can settle the terminal state.
          yield* sql`
          UPDATE projection_thread_execution_intents
          SET desired_state = CASE
                WHEN last_failure_type = 'turn-association-pending' THEN 'running'
                ELSE 'stopped'
              END,
              phase = CASE
                WHEN last_failure_type = 'turn-association-pending' THEN 'retry-wait'
                WHEN phase = 'recovery-exhausted' THEN phase
                ELSE 'stopping'
              END,
              runnable = CASE WHEN last_failure_type = 'turn-association-pending' THEN 1 ELSE 0 END,
              next_attempt_at = CASE WHEN last_failure_type = 'turn-association-pending' THEN ${at} ELSE NULL END,
              claim_owner = NULL,
              claim_generation = claim_generation + 1,
              claim_expires_at = NULL,
              last_failure_type = CASE
                WHEN last_failure_type = 'turn-association-pending' THEN last_failure_type
                ELSE ${reason}
              END,
              updated_at = ${at},
              terminal_at = CASE
                WHEN last_failure_type = 'turn-association-pending' THEN NULL
                ELSE COALESCE(terminal_at, ${at})
              END
          WHERE thread_id = ${threadId} AND desired_state = 'running'
        `;
          yield* sql`
          INSERT INTO session_recovery_state (
            thread_id, desired_state, reason, last_execution_id, attempts,
            last_attempt_at, next_attempt_at, recovered_at, gave_up_at, updated_at
          ) VALUES (${threadId}, 'stopped', ${reason}, NULL, 0, NULL, NULL, NULL, NULL, ${at})
          ON CONFLICT(thread_id) DO UPDATE SET desired_state = 'stopped', reason = excluded.reason,
            next_attempt_at = NULL, gave_up_at = NULL, updated_at = excluded.updated_at
        `;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.stopThread", cause, threadId),
        ),
      );

  const retryExhausted: DurableExecutionIntentRepositoryShape["retryExhausted"] = ({
    threadId,
    at,
  }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly workItemId: string }>`
          UPDATE projection_thread_execution_intents
          SET desired_state = 'running', phase = 'recovering', runnable = 1,
              recovery_attempts = 0, next_attempt_at = ${at},
              claim_owner = NULL, claim_generation = claim_generation + 1,
              claim_expires_at = NULL, last_failure_type = NULL, last_failure_detail = NULL,
              exhausted_at = NULL, terminal_at = NULL, dismissed_at = NULL, updated_at = ${at}
          WHERE work_item_id = (
            SELECT work_item_id FROM projection_thread_execution_intents
            WHERE thread_id = ${threadId} AND phase = 'recovery-exhausted'
              AND dismissed_at IS NULL
            ORDER BY accepted_at DESC LIMIT 1
          )
          RETURNING work_item_id AS "workItemId"
        `;
          if (rows.length === 0) return false;
          yield* sql`
          UPDATE thread_execution_bootstrap_operations
          SET worktree_phase = CASE WHEN worktree_phase = 'failed' THEN 'pending' ELSE worktree_phase END,
              setup_phase = CASE WHEN setup_phase = 'failed' THEN 'pending' ELSE setup_phase END,
              last_failure_detail = NULL,
              updated_at = ${at}
          WHERE work_item_id = ${rows[0]!.workItemId}
        `;
          yield* sql`
          UPDATE session_recovery_state
          SET desired_state = 'running', reason = 'user-retry', attempts = 0,
              last_attempt_at = NULL, next_attempt_at = ${at}, recovered_at = NULL,
              gave_up_at = NULL, updated_at = ${at}
          WHERE thread_id = ${threadId}
        `;
          return true;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError("DurableExecutionIntentRepository.retryExhausted", cause, threadId),
        ),
      );

  const dismissExhausted: DurableExecutionIntentRepositoryShape["dismissExhausted"] = ({
    threadId,
    at,
  }) =>
    sql<{ readonly workItemId: string }>`
      UPDATE projection_thread_execution_intents
      SET dismissed_at = ${at}, updated_at = ${at}, claim_generation = claim_generation + 1
      WHERE work_item_id = (
        SELECT work_item_id FROM projection_thread_execution_intents
        WHERE thread_id = ${threadId} AND phase = 'recovery-exhausted'
          AND dismissed_at IS NULL
        ORDER BY accepted_at DESC LIMIT 1
      )
      RETURNING work_item_id AS "workItemId"
    `.pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError((cause) =>
        persistenceError("DurableExecutionIntentRepository.dismissExhausted", cause, threadId),
      ),
    );

  const observeSession: DurableExecutionIntentRepositoryShape["observeSession"] = (input) => {
    const failureType = `provider-session-${input.status}`;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          // A provider-acknowledged steer association remains runnable through
          // a terminal lifecycle observation. The adoption event is still
          // needed to consume its exact pending placeholder; other intents on
          // this thread must still receive the normal lifecycle settlement.
          if (
            input.status === "idle" ||
            input.status === "ready" ||
            input.status === "error" ||
            input.status === "interrupted" ||
            input.status === "stopped"
          ) {
            const associationPending = yield* sql<{ readonly workItemId: string }>`
              SELECT work_item_id AS "workItemId"
              FROM projection_thread_execution_intents
              WHERE thread_id = ${input.threadId}
                AND desired_state = 'running'
                AND last_failure_type = 'turn-association-pending'
              LIMIT 1
            `;
            if (associationPending.length > 0) {
              yield* sql`
                UPDATE projection_thread_execution_intents
                SET next_attempt_at = ${input.at}, updated_at = ${input.at}
                WHERE work_item_id = ${associationPending[0]!.workItemId}
              `;
            }
          }
          if (input.status === "running" && input.providerTurnId !== null) {
            yield* sql`
            UPDATE projection_thread_execution_intents
            SET phase = 'running', delivery_certainty = 'provider-acknowledged',
                provider_turn_id = ${input.providerTurnId},
                started_at = COALESCE(started_at, ${input.at}), updated_at = ${input.at}
            WHERE work_item_id = (
              SELECT work_item_id FROM projection_thread_execution_intents
              WHERE thread_id = ${input.threadId} AND desired_state = 'running'
                AND phase IN ('starting', 'recovering')
              ORDER BY request_event_sequence ASC LIMIT 1
            )
          `;
            return;
          }
          if (input.status === "idle" || input.status === "ready") {
            yield* sql`
            UPDATE projection_thread_execution_intents
            SET desired_state = 'stopped', phase = 'running', delivery_certainty = 'completed',
                runnable = 0, next_attempt_at = NULL, terminal_at = ${input.at},
                updated_at = ${input.at}
            WHERE thread_id = ${input.threadId} AND desired_state = 'running'
              AND COALESCE(last_failure_type, '') <> 'turn-association-pending'
              AND phase IN ('running', 'waiting-for-approval', 'waiting-for-input')
          `;
            yield* sql`
            UPDATE projection_thread_execution_intents
            SET runnable = 1, next_attempt_at = ${input.at}, updated_at = ${input.at}
            WHERE work_item_id = (
              SELECT work_item_id FROM projection_thread_execution_intents
              WHERE thread_id = ${input.threadId} AND desired_state = 'running'
                AND phase IN ('queued', 'recovering') AND runnable = 0
              ORDER BY request_event_sequence ASC LIMIT 1
            )
          `;
          } else if (
            input.status === "error" ||
            input.status === "interrupted" ||
            input.status === "stopped"
          ) {
            // T3-CUSTOM(expbkt3): an item whose recovery budget is already spent
            // cannot be claimed again (`recovery_attempts < maximum_recovery_attempts`
            // gates every claim), so parking it in 'recovering' leaves a zombie
            // that shows "Recovering" forever and head-of-line-blocks every later
            // prompt on the thread. Exhaust it terminally instead; the user gets
            // Retry/Dismiss and the next prompt runs.
            yield* sql`
            UPDATE projection_thread_execution_intents
            SET phase = CASE
                  WHEN recovery_attempts >= maximum_recovery_attempts THEN 'recovery-exhausted'
                  ELSE 'recovering'
                END,
                desired_state = CASE
                  WHEN recovery_attempts >= maximum_recovery_attempts THEN 'stopped'
                  ELSE desired_state
                END,
                runnable = CASE
                  WHEN recovery_attempts >= maximum_recovery_attempts THEN 0
                  ELSE runnable
                END,
                delivery_certainty = CASE WHEN phase = 'starting' THEN 'uncertain' ELSE delivery_certainty END,
                next_attempt_at = CASE
                  WHEN recovery_attempts >= maximum_recovery_attempts THEN NULL
                  ELSE ${input.at}
                END,
                exhausted_at = CASE
                  WHEN recovery_attempts >= maximum_recovery_attempts THEN ${input.at}
                  ELSE exhausted_at
                END,
                terminal_at = CASE
                  WHEN recovery_attempts >= maximum_recovery_attempts THEN ${input.at}
                  ELSE terminal_at
                END,
                last_failure_type = ${failureType},
                last_failure_detail = ${input.error}, updated_at = ${input.at}
            WHERE work_item_id = (
              SELECT work_item_id FROM projection_thread_execution_intents
              WHERE thread_id = ${input.threadId} AND desired_state = 'running'
                AND phase IN ('starting', 'running') AND claim_owner IS NULL
                AND COALESCE(last_failure_type, '') <> 'turn-association-pending'
              ORDER BY request_event_sequence ASC LIMIT 1
            )
          `;
          }
          const remaining = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM projection_thread_execution_intents
          WHERE thread_id = ${input.threadId} AND desired_state = 'running'
        `;
          if ((remaining[0]?.count ?? 0) === 0) {
            yield* sql`
            UPDATE session_recovery_state
            SET desired_state = 'stopped', reason = 'turn-completed', next_attempt_at = NULL,
                updated_at = ${input.at}
            WHERE thread_id = ${input.threadId}
          `;
          }
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          persistenceError(
            "DurableExecutionIntentRepository.observeSession",
            cause,
            input.threadId,
          ),
        ),
      );
  };

  const observeBlockingActivity: DurableExecutionIntentRepositoryShape["observeBlockingActivity"] =
    ({ threadId, kind, at, responseMode }) => {
      const requested = kind === "approval.requested" || kind === "user-input.requested";
      const requestIsBlocking =
        requested && !(kind === "user-input.requested" && responseMode === "message");
      return sql`
        WITH request_lifecycle AS (
          SELECT
            kind,
            turn_id,
            json_extract(payload_json, '$.requestId') AS request_id,
            json_extract(payload_json, '$.responseMode') AS response_mode,
            lower(COALESCE(json_extract(payload_json, '$.detail'), '')) AS detail,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(payload_json, '$.requestId')
              ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
                       sequence DESC, created_at DESC, activity_id DESC
            ) AS request_order
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND (
              kind IN ('approval.requested', 'approval.resolved', 'user-input.requested', 'user-input.resolved')
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
            AND json_extract(payload_json, '$.requestId') IS NOT NULL
        ), blockers AS (
          SELECT COUNT(*) AS count
          FROM request_lifecycle
          WHERE request_order = 1
            AND (
              kind = 'approval.requested'
              OR (kind = 'user-input.requested' AND COALESCE(response_mode, '') <> 'message')
            )
            AND (
              turn_id IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM projection_turns AS turn
                WHERE turn.thread_id = ${threadId}
                  AND turn.turn_id = request_lifecycle.turn_id
                  AND turn.state IN ('completed', 'interrupted', 'error')
              )
            )
        )
        UPDATE projection_thread_execution_intents
        SET phase = CASE
              WHEN (SELECT count FROM blockers) > 0 THEN CASE
                WHEN EXISTS (SELECT 1 FROM request_lifecycle WHERE request_order = 1 AND kind = 'approval.requested')
                THEN 'waiting-for-approval'
                ELSE 'waiting-for-input'
              END
              WHEN ${requestIsBlocking ? 1 : 0} THEN ${kind.startsWith("approval") ? "waiting-for-approval" : "waiting-for-input"}
              WHEN phase IN ('waiting-for-approval', 'waiting-for-input') THEN 'running'
              ELSE phase
            END,
            runnable = CASE
              WHEN (SELECT count FROM blockers) > 0 OR ${requestIsBlocking ? 1 : 0} THEN 0
              WHEN phase IN ('waiting-for-approval', 'waiting-for-input') THEN 1
              ELSE runnable
            END,
            next_attempt_at = CASE WHEN (SELECT count FROM blockers) > 0 OR ${requestIsBlocking ? 1 : 0} THEN NULL ELSE next_attempt_at END,
            claim_owner = CASE WHEN (SELECT count FROM blockers) > 0 OR ${requestIsBlocking ? 1 : 0} THEN NULL ELSE claim_owner END,
            claim_generation = claim_generation + CASE WHEN (SELECT count FROM blockers) > 0 OR ${requestIsBlocking ? 1 : 0} THEN 1 ELSE 0 END,
            claim_expires_at = CASE WHEN (SELECT count FROM blockers) > 0 OR ${requestIsBlocking ? 1 : 0} THEN NULL ELSE claim_expires_at END,
            updated_at = ${at}
        WHERE work_item_id = (
          SELECT work_item_id FROM projection_thread_execution_intents
          WHERE thread_id = ${threadId} AND desired_state = 'running'
            AND phase IN ('running', 'starting', 'recovering', 'waiting-for-approval', 'waiting-for-input')
          ORDER BY request_event_sequence DESC LIMIT 1
        )
      `.pipe(
        Effect.asVoid,
        Effect.mapError((cause) =>
          persistenceError(
            "DurableExecutionIntentRepository.observeBlockingActivity",
            cause,
            threadId,
          ),
        ),
      );
    };

  return {
    acceptFromEvent,
    getByWorkItemId,
    listByThreadId,
    countVisibleByPhase,
    reconcileStartup,
    listRunnable,
    nextRunnableAt,
    claim,
    isClaimCurrent,
    renewClaim,
    markProviderStarting,
    getBootstrapOperation,
    beginBootstrapStep,
    beginWorktreeCreation,
    acknowledgeBootstrapStep,
    markBootstrapStepFailed,
    deferClaim,
    beginRecoveryAttempt,
    markAcknowledged,
    markAssociationPending,
    markCompletedFromHistory,
    markOriginalDispatchFailed,
    markRecoveryAttemptFailed,
    markFailedAttention,
    stopThread,
    retryExhausted,
    dismissExhausted,
    observeSession,
    observeBlockingActivity,
  };
});

export const DurableExecutionIntentRepositoryLive = Layer.effect(
  DurableExecutionIntentRepository,
  make,
);
