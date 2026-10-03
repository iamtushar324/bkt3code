// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** Retained fork integrations read a V1-shaped view of the authoritative V2 projection. */
import {
  OrchestrationThread,
  OrchestrationThreadShell,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationProposedPlan,
  OrchestrationCheckpointSummary,
} from "@t3tools/contracts/orchestration";
import {
  OrchestrationV2ThreadShellJson,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  TurnId,
  EventId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { threadShellFromProjection } from "./ProjectionStore.ts";

const iso = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);
export function legacyThreadShell(
  shell: OrchestrationV2ThreadShell,
  providerName?: string | null,
): OrchestrationThreadShell {
  const wire = Schema.encodeSync(OrchestrationV2ThreadShellJson)(shell);
  const running = shell.activeRunId !== null;
  return Schema.decodeUnknownSync(OrchestrationThreadShell)({
    ...wire,
    ownerUserId: shell.ownerUserId ?? null,
    memberUserIds: shell.memberUserIds ?? [],
    sourceControlProfileId: shell.sourceControlProfileId ?? null,
    parentThreadId:
      shell.parentThreadId === undefined ? shell.lineage.parentThreadId : shell.parentThreadId,
    latestTurn:
      shell.latestRunId === null
        ? null
        : {
            turnId: shell.latestRunId,
            state: running
              ? "running"
              : shell.status === "failed"
                ? "error"
                : shell.status === "interrupted"
                  ? "interrupted"
                  : "completed",
            requestedAt: iso(shell.latestRunRequestedAt) ?? wire.updatedAt,
            startedAt: iso(shell.latestRunStartedAt),
            completedAt: iso(shell.latestRunCompletedAt),
            assistantMessageId: null,
            durationMs:
              shell.latestRunStartedAt == null || shell.latestRunCompletedAt == null
                ? null
                : Math.max(
                    0,
                    DateTime.toEpochMillis(shell.latestRunCompletedAt) -
                      DateTime.toEpochMillis(shell.latestRunStartedAt),
                  ),
          },
    session: {
      threadId: shell.id,
      providerName:
        providerName ??
        (["claudeAgent", "codex", "opencode", "cursor", "grok", "antigravity"].includes(
          shell.providerInstanceId,
        )
          ? shell.providerInstanceId
          : null),
      providerInstanceId: shell.providerInstanceId,
      providerThreadId: null,
      status: running ? "running" : shell.status === "failed" ? "error" : "ready",
      runtimeMode: shell.runtimeMode,
      activeTurnId: shell.activeRunId,
      lastError: shell.lastError,
      updatedAt: wire.updatedAt,
    },
    hasPendingApprovals:
      shell.pendingRuntimeRequest !== null && shell.pendingRuntimeRequest.kind !== "user_input",
    hasPendingUserInput: shell.pendingRuntimeRequest?.kind === "user_input",
    hasPendingAsyncUserInput: shell.hasPendingAsyncUserInput ?? false,
  });
}

export function legacyActivities(
  projection: Pick<OrchestrationV2ThreadProjection, "turnItems">,
): ReadonlyArray<OrchestrationThreadActivity> {
  return projection.turnItems
    .filter((item) => item.type !== "assistant_message" && item.type !== "user_message")
    .map((item) =>
      item.type === "dynamic_tool" &&
      typeof item.input === "object" &&
      item.input !== null &&
      "forkLegacyActivity" in item.input
        ? Schema.decodeUnknownSync(OrchestrationThreadActivity)(item.input.forkLegacyActivity)
        : Schema.decodeUnknownSync(OrchestrationThreadActivity)({
            id: EventId.make(item.id),
            tone:
              item.type === "error"
                ? "error"
                : item.type === "user_input_request" || item.type === "approval_request"
                  ? "approval"
                  : "tool",
            kind:
              item.type === "user_input_request"
                ? "user-input.requested"
                : item.type === "approval_request"
                  ? "approval.requested"
                  : item.type,
            summary:
              item.title ||
              (item.type === "error" ? item.failure.message : item.type.replaceAll("_", " ")),
            payload: {
              ...item,
              ...(item.type === "user_input_request" || item.type === "approval_request"
                ? {
                    requestId: item.requestId,
                    status: item.status,
                    responseMode:
                      item.type === "user_input_request" ? item.responseMode : undefined,
                  }
                : {}),
            },
            turnId: item.runId === null ? null : TurnId.make(item.runId),
            createdAt: iso(item.startedAt) ?? iso(item.updatedAt),
          }),
    );
}

/** Imports written before cursor preservation can still recover the original V1 cursor. */
export function withRetainedActivitySequence(
  activity: OrchestrationThreadActivity,
  retained?: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  return activity.sequence === undefined && retained?.sequence !== undefined
    ? { ...activity, sequence: retained.sequence }
    : activity;
}

/** V1 detail tables are immutable history after the cutover, never a second engine. */
export const legacyStoredHistory = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const activities = yield* sql<{
      id: string;
      tone: string;
      kind: string;
      summary: string;
      payload: string;
      turnId: string | null;
      sequence: number | null;
      createdAt: string;
    }>`
    SELECT activity_id AS id, tone, kind, summary, payload_json AS payload, turn_id AS turnId, sequence, created_at AS createdAt FROM projection_thread_activities WHERE thread_id = ${threadId} ORDER BY sequence ASC, created_at ASC, activity_id ASC
  `;
    const plans = yield* sql<{
      id: string;
      turnId: string | null;
      planMarkdown: string;
      implementedAt: string | null;
      implementationThreadId: string | null;
      createdAt: string;
      updatedAt: string;
    }>`
    SELECT plan_id AS id, turn_id AS turnId, plan_markdown AS planMarkdown, implemented_at AS implementedAt, implementation_thread_id AS implementationThreadId, created_at AS createdAt, updated_at AS updatedAt FROM projection_thread_proposed_plans WHERE thread_id = ${threadId} ORDER BY created_at ASC, plan_id ASC
  `;
    const checkpoints = yield* sql<{
      turnId: string;
      checkpointTurnCount: number;
      checkpointRef: string;
      status: string;
      files: string;
      assistantMessageId: string | null;
      completedAt: string;
    }>`
    SELECT turn_id AS turnId, checkpoint_turn_count AS checkpointTurnCount, checkpoint_ref AS checkpointRef, checkpoint_status AS status, checkpoint_files_json AS files, assistant_message_id AS assistantMessageId, completed_at AS completedAt FROM projection_turns WHERE thread_id = ${threadId} AND turn_id IS NOT NULL AND checkpoint_ref IS NOT NULL AND completed_at IS NOT NULL ORDER BY checkpoint_turn_count ASC
  `;
    return {
      activities: activities.map((row) =>
        Schema.decodeUnknownSync(OrchestrationThreadActivity)({
          ...row,
          // V1 rows predating sequence attribution have no cursor, rather than cursor zero.
          sequence: row.sequence ?? undefined,
          payload: JSON.parse(row.payload),
        }),
      ),
      proposedPlans: plans.map((row) => Schema.decodeUnknownSync(OrchestrationProposedPlan)(row)),
      checkpoints: checkpoints.map((row) =>
        Schema.decodeUnknownSync(OrchestrationCheckpointSummary)({
          ...row,
          files: JSON.parse(row.files),
        }),
      ),
    };
  });

export function legacyThreadDetail(
  projection: OrchestrationV2ThreadProjection,
  history: Effect.Success<ReturnType<typeof legacyStoredHistory>>,
): OrchestrationThread {
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === projection.thread.activeProviderThreadId,
  );
  const shell = legacyThreadShell(threadShellFromProjection(projection), providerThread?.driver);
  const nativeId = providerThread?.nativeThreadRef?.nativeId ?? null;
  const retainedActivities = new Map(history.activities.map((activity) => [activity.id, activity]));
  const activities = legacyActivities(projection).map((activity) =>
    withRetainedActivitySequence(activity, retainedActivities.get(activity.id)),
  );
  const activityIds = new Set(activities.map((activity) => activity.id));
  const planIds = new Set(projection.plans.map((plan) => String(plan.id)));
  const checkpointRefs = new Set(
    projection.checkpoints.map((checkpoint) => String(checkpoint.ref)),
  );
  return Schema.decodeUnknownSync(OrchestrationThread)({
    ...shell,
    deletedAt: iso(projection.thread.deletedAt),
    messages: projection.messages
      .filter((message) => message.role !== "system")
      .map((message) =>
        Schema.decodeUnknownSync(OrchestrationMessage)({
          ...message,
          turnId: message.runId,
          sentByUserId: message.sentByUserId ?? null,
          createdAt: iso(message.createdAt),
          updatedAt: iso(message.updatedAt),
        }),
      ),
    activities: [
      ...history.activities.filter((activity) => !activityIds.has(activity.id)),
      ...activities,
    ],
    proposedPlans: [
      ...history.proposedPlans.filter((plan) => !planIds.has(plan.id)),
      ...projection.plans
        .filter((plan) => plan.kind === "proposed_plan")
        .map((plan) => {
          const original = history.proposedPlans.find((item) => item.id === plan.id);
          return {
            ...original,
            id: plan.id,
            turnId: plan.runId,
            planMarkdown: plan.markdown,
            implementedAt:
              plan.status === "completed"
                ? (original?.implementedAt ?? iso(projection.updatedAt))
                : null,
            implementationThreadId: original?.implementationThreadId ?? null,
            createdAt: original?.createdAt ?? iso(projection.thread.createdAt),
            updatedAt: original?.updatedAt ?? iso(projection.updatedAt),
          };
        }),
    ],
    checkpoints: [
      ...history.checkpoints.filter((checkpoint) => !checkpointRefs.has(checkpoint.checkpointRef)),
      ...projection.checkpoints
        .filter((checkpoint) => checkpoint.appRunOrdinal != null && checkpoint.runId !== null)
        .map((checkpoint) => ({
          turnId: checkpoint.runId,
          checkpointTurnCount: checkpoint.appRunOrdinal,
          checkpointRef: checkpoint.ref,
          status: checkpoint.status === "stale" ? "missing" : checkpoint.status,
          files: checkpoint.files,
          assistantMessageId:
            projection.messages.findLast(
              (message) => message.runId === checkpoint.runId && message.role === "assistant",
            )?.id ?? null,
          completedAt: iso(checkpoint.capturedAt),
        })),
    ],
    session: shell.session === null ? null : { ...shell.session, providerThreadId: nativeId },
  });
}
