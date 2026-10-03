// T3-CUSTOM(expbkt3): retained BK behavior at the native V2 boundary.
/** Preserve V1 history in native V2 records without activating historical work. */
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  RunId,
  ThreadId,
  TurnItemId,
  OrchestrationV2Checkpoint,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { agentUiHandleFromOutput } from "../agentui/turnItemUi.expbkt3.ts";
import { OrchestrationThreadActivity } from "@t3tools/contracts/orchestration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError } from "../persistence/Errors.ts";

export interface LegacyRunRow {
  readonly turn_id: string;
  readonly pending_message_id: string | null;
  readonly state: string;
  readonly requested_at: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly checkpoint_turn_count: number | null;
  readonly checkpoint_ref: string | null;
  readonly checkpoint_status: string | null;
  readonly checkpoint_files_json: string;
  readonly ordinal: number;
}
const date = DateTime.makeUnsafe;
const nullableDate = (value: string | null) => (value === null ? null : date(value));
const historicalRunStatus = (state: string) =>
  state === "error" || state === "failed"
    ? ("failed" as const)
    : state === "completed"
      ? ("completed" as const)
      : ("interrupted" as const);

export function legacyRunEvents(
  thread: OrchestrationV2AppThread,
  rows: ReadonlyArray<LegacyRunRow>,
  workspaceRoot: string,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const events: OrchestrationV2DomainEvent[] = [];
  let parentCheckpointId: CheckpointId | null = null;
  for (const row of rows) {
    const runId = RunId.make(row.turn_id);
    const nodeId = NodeId.make(`migration:v1:node:${row.turn_id}`);
    const scopeId = CheckpointScopeId.make(`migration:v1:scope:${row.turn_id}`);
    const capturedAt = date(row.completed_at ?? row.started_at ?? row.requested_at);
    const checkpointId =
      row.checkpoint_ref === null
        ? null
        : CheckpointId.make(`migration:v1:checkpoint:${row.turn_id}`);
    const status = historicalRunStatus(row.state);
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: thread.id,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "root_turn",
      status,
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: scopeId,
      startedAt: nullableDate(row.started_at),
      completedAt: capturedAt,
    };
    events.push(
      {
        id: EventId.make(`migration:v1:run:${row.turn_id}`),
        type: "run.created",
        threadId: thread.id,
        occurredAt: capturedAt,
        payload: {
          id: runId,
          threadId: thread.id,
          ordinal: row.ordinal,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(
            row.pending_message_id ?? `migration:v1:message:${row.turn_id}`,
          ),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status,
          requestedAt: date(row.requested_at),
          startedAt: nullableDate(row.started_at),
          completedAt: capturedAt,
          checkpointId,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make(`migration:v1:node:${row.turn_id}`),
        type: "node.updated",
        threadId: thread.id,
        occurredAt: capturedAt,
        payload: node,
      },
      {
        id: EventId.make(`migration:v1:scope:${row.turn_id}`),
        type: "checkpoint-scope.created",
        threadId: thread.id,
        occurredAt: capturedAt,
        payload: {
          id: scopeId,
          threadId: thread.id,
          runId,
          nodeId,
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: row.ordinal,
          advancesAppRunCount: true,
          cwd: thread.worktreePath ?? workspaceRoot,
          createdAt: date(row.requested_at),
        },
      },
    );
    if (checkpointId !== null && row.checkpoint_ref !== null) {
      const checkpoint = Schema.decodeUnknownSync(OrchestrationV2Checkpoint)({
        id: checkpointId,
        threadId: thread.id,
        scopeId,
        runId,
        nodeId,
        parentCheckpointId,
        ordinalWithinScope: 1,
        appRunOrdinal:
          row.checkpoint_turn_count !== null && row.checkpoint_turn_count > 0
            ? row.checkpoint_turn_count
            : row.ordinal,
        ref: CheckpointRef.make(row.checkpoint_ref),
        status: row.checkpoint_status ?? "ready",
        files: JSON.parse(row.checkpoint_files_json),
        capturedAt,
      });
      events.push({
        id: EventId.make(`migration:v1:checkpoint:${row.turn_id}`),
        type: "checkpoint.captured",
        threadId: thread.id,
        occurredAt: capturedAt,
        payload: checkpoint,
      });
      parentCheckpointId = checkpointId;
    }
  }
  return events;
}

export function legacyActivityItem(
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  ordinal: number,
): OrchestrationV2TurnItem {
  const at = date(activity.createdAt);
  const t3Ui = agentUiHandleFromOutput(activity.payload);
  return {
    id: TurnItemId.make(`migration:v1:activity:${activity.id}`),
    threadId,
    runId: activity.turnId === null ? null : RunId.make(activity.turnId),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: activity.tone === "error" ? "failed" : "completed",
    title: activity.summary,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName: activity.kind,
    input: { forkLegacyActivity: activity },
    output: t3Ui === undefined ? null : { t3Ui },
  };
}

export const reserveLegacyTimelinePositions = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The first shell preview reserves its final slot, so later lazy hydration cannot reorder it.
    yield* sql`WITH timeline AS (
    SELECT 'migration:v1:turn-item:' || message_id AS item_id, created_at, 0 AS kind_order, message_id AS source_id FROM projection_thread_messages WHERE thread_id=${threadId}
    UNION ALL SELECT 'migration:v1:activity:' || activity_id, created_at, 1, activity_id FROM projection_thread_activities WHERE thread_id=${threadId}
    UNION ALL SELECT 'migration:v1:plan-item:' || plan_id, created_at, 2, plan_id FROM projection_thread_proposed_plans WHERE thread_id=${threadId}
  ), positioned AS (SELECT item_id, ROW_NUMBER() OVER (ORDER BY created_at ASC,kind_order ASC,source_id ASC) AS ordinal FROM timeline)
  INSERT INTO orchestration_v2_turn_item_positions (thread_id,turn_item_id,ordinal)
  SELECT ${threadId},item_id,ordinal FROM positioned WHERE true ON CONFLICT(thread_id,turn_item_id) DO NOTHING`;
  });

/** Read only question lifecycle rows once; shell refreshes use the persisted native metadata. */
export const legacyPendingAsyncUserInputIds = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ kind: string; request_id: unknown; response_mode: unknown }>`
    SELECT kind,json_extract(payload_json,'$.requestId') AS request_id,
      json_extract(payload_json,'$.responseMode') AS response_mode
    FROM projection_thread_activities WHERE thread_id=${threadId}
      AND kind IN ('user-input.requested','user-input.resolved','user-input.dismissed','user-input.expired')
    ORDER BY sequence ASC,created_at ASC,activity_id ASC
  `;
    const pending = new Set<string>();
    for (const row of rows) {
      if (typeof row.request_id !== "string" || row.request_id.trim().length === 0) continue;
      if (row.kind === "user-input.requested") {
        if (row.response_mode === "message") pending.add(row.request_id);
      } else pending.delete(row.request_id);
    }
    return [...pending];
  });

export const forkLegacyHistoryEvents = (thread: OrchestrationV2AppThread) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projects = yield* sql<{
      workspace_root: string;
    }>`SELECT workspace_root FROM projection_projects WHERE project_id=${thread.projectId}`;
    const workspaceRoot = projects[0]?.workspace_root;
    if (workspaceRoot === undefined)
      return yield* new PersistenceSqlError({
        operation: "import legacy checkpoint workspace",
        correlation: { threadId: thread.id },
        detail: "The legacy project workspace is missing.",
      });
    const runs = yield* sql<LegacyRunRow>`
    SELECT turn_id, pending_message_id, state, requested_at, started_at, completed_at,
      checkpoint_turn_count, checkpoint_ref, checkpoint_status, checkpoint_files_json,
      ROW_NUMBER() OVER (ORDER BY requested_at ASC, turn_id ASC) AS ordinal
    FROM projection_turns WHERE thread_id = ${thread.id} AND turn_id IS NOT NULL
    ORDER BY requested_at ASC, turn_id ASC
  `;
    const events = [...legacyRunEvents(thread, runs, workspaceRoot)];
    const reasoning = yield* sql<{
      message_id: string;
      turn_id: string | null;
      text: string;
      created_at: string;
      updated_at: string;
      ordinal: number;
    }>`SELECT message.message_id,message.turn_id,message.text,message.created_at,message.updated_at,position.ordinal FROM projection_thread_messages message INNER JOIN orchestration_v2_turn_item_positions position ON position.thread_id=message.thread_id AND position.turn_item_id='migration:v1:turn-item:' || message.message_id WHERE message.thread_id=${thread.id} AND message.role='reasoning' ORDER BY message.created_at ASC,message.message_id ASC`;
    for (const row of reasoning) {
      const at = date(row.updated_at);
      events.push({
        id: EventId.make(`migration:v1:reasoning:${row.message_id}`),
        type: "turn-item.updated",
        threadId: thread.id,
        occurredAt: at,
        payload: {
          id: TurnItemId.make(`migration:v1:turn-item:${row.message_id}`),
          threadId: thread.id,
          runId: row.turn_id === null ? null : RunId.make(row.turn_id),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: row.ordinal,
          status: "completed",
          title: null,
          startedAt: date(row.created_at),
          completedAt: at,
          updatedAt: at,
          type: "reasoning",
          text: row.text,
          streaming: false,
        },
      });
    }
    const activityRows = yield* sql<{
      activity_id: string;
      tone: string;
      kind: string;
      summary: string;
      payload_json: string;
      turn_id: string | null;
      created_at: string;
      ordinal: number;
    }>`
    SELECT activity.activity_id, activity.tone, activity.kind, activity.summary, activity.payload_json, activity.turn_id, activity.created_at, position.ordinal
    FROM projection_thread_activities activity INNER JOIN orchestration_v2_turn_item_positions position ON position.thread_id=activity.thread_id AND position.turn_item_id='migration:v1:activity:' || activity.activity_id
    WHERE activity.thread_id = ${thread.id} ORDER BY activity.created_at ASC, activity.activity_id ASC
  `;
    for (const row of activityRows) {
      const payload = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        row.payload_json,
      );
      const activity = yield* Schema.decodeUnknownEffect(OrchestrationThreadActivity)({
        id: row.activity_id,
        tone: row.tone,
        kind: row.kind,
        summary: row.summary,
        payload,
        turnId: row.turn_id,
        createdAt: row.created_at,
      });
      const item = legacyActivityItem(thread.id, activity, row.ordinal);
      events.push({
        id: EventId.make(item.id),
        type: "turn-item.updated",
        threadId: thread.id,
        occurredAt: item.updatedAt,
        payload: item,
      });
    }
    const plans = yield* sql<{
      plan_id: string;
      turn_id: string | null;
      plan_markdown: string;
      implemented_at: string | null;
      created_at: string;
      updated_at: string;
      ordinal: number;
    }>`
    SELECT plan.plan_id,plan.turn_id,plan.plan_markdown,plan.implemented_at,plan.created_at,plan.updated_at,position.ordinal
    FROM projection_thread_proposed_plans plan INNER JOIN orchestration_v2_turn_item_positions position ON position.thread_id=plan.thread_id AND position.turn_item_id='migration:v1:plan-item:' || plan.plan_id
    WHERE plan.thread_id = ${thread.id} ORDER BY plan.created_at ASC, plan.plan_id ASC
  `;
    for (const row of plans) {
      const id = PlanId.make(row.plan_id);
      const nodeId = NodeId.make(`migration:v1:plan-node:${row.plan_id}`);
      const runId = row.turn_id === null ? null : RunId.make(row.turn_id);
      const at = date(row.updated_at);
      events.push({
        id: EventId.make(`migration:v1:plan:${row.plan_id}`),
        type: "plan.updated",
        threadId: thread.id,
        occurredAt: at,
        payload: {
          id,
          threadId: thread.id,
          runId,
          nodeId,
          kind: "proposed_plan",
          status: row.implemented_at === null ? "active" : "completed",
          markdown: row.plan_markdown,
        },
      });
      // Plans remain visible even when V1 only stored an artifact, without a tool activity.
      events.push({
        id: EventId.make(`migration:v1:plan-item:${row.plan_id}`),
        type: "turn-item.updated",
        threadId: thread.id,
        occurredAt: at,
        payload: {
          id: TurnItemId.make(`migration:v1:plan-item:${row.plan_id}`),
          threadId: thread.id,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: row.ordinal,
          status: "completed",
          title: "Proposed plan",
          startedAt: date(row.created_at),
          completedAt: at,
          updatedAt: at,
          type: "proposed_plan",
          planId: id,
          markdown: row.plan_markdown,
          streaming: false,
        },
      });
    }
    const existing = yield* sql<{
      event_id: string;
    }>`SELECT event_id FROM orchestration_events WHERE application_event_version=2 AND aggregate_kind='thread' AND stream_id=${thread.id} AND event_id LIKE 'migration:v1:%'`;
    const ids = new Set(existing.map((row) => row.event_id));
    return events.filter((event) => !ids.has(event.id));
  });
