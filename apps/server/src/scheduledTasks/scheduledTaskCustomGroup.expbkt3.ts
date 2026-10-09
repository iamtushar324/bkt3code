// T3-CUSTOM(expbkt3): BK sidebar custom group for the threads a scheduled task launches.
//
// A run of a task that is not bound to a thread (bindToCurrentThread:false)
// launches a fresh top-level thread. Automations file those threads under a
// custom group (XFN-59), so the label is stored per task and applied to every
// launch.
//
// The label lives in the fork-owned side table `scheduled_task_custom_groups`
// (migration 1051), not in a column of upstream's `scheduled_tasks`: the task
// contract, its upsert SQL and the web editor stay upstream's, and a web save
// neither sees nor clears the label. A label is written only while its task
// exists, and `ScheduledTaskService` deletes it together with its task, so the
// table holds no orphans without a cascading foreign key (see the migration).
import {
  OrchestratorMcpFailure,
  ThreadCustomGroup,
  type OrchestratorMcpScheduledTask,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const decodeStoredCustomGroup = Schema.decodeUnknownOption(ThreadCustomGroup);

/** The task's label, or null when it has none or the stored value is no longer a valid label. */
export const readScheduledTaskCustomGroup = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId) =>
  sql<{ readonly custom_group: string }>`
    SELECT custom_group FROM scheduled_task_custom_groups WHERE task_id = ${taskId}
  `.pipe(
    Effect.map((rows) =>
      rows[0] === undefined
        ? null
        : Option.getOrNull(decodeStoredCustomGroup(rows[0].custom_group)),
    ),
  );

/** Removes the task's label. ScheduledTaskService runs it in the task's delete transaction. */
export const deleteScheduledTaskCustomGroup = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId) =>
  sql`DELETE FROM scheduled_task_custom_groups WHERE task_id = ${taskId}`.pipe(Effect.asVoid);

/**
 * Sets the task's label, or removes it for null. A label for a task that no
 * longer exists is not stored, so a delete that races this write leaves no row.
 */
export const writeScheduledTaskCustomGroup = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
  customGroup: ThreadCustomGroup | null,
) =>
  customGroup === null
    ? deleteScheduledTaskCustomGroup(sql, taskId)
    : sql`
        INSERT INTO scheduled_task_custom_groups (task_id, custom_group)
        SELECT ${taskId}, ${customGroup}
        WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${taskId})
        ON CONFLICT (task_id) DO UPDATE SET custom_group = excluded.custom_group
      `.pipe(Effect.asVoid);

/**
 * The fields a fresh thread launched for the task takes: its label, if any.
 * Never fails: a label is cosmetic and must not stop a run or hide a task.
 */
export const scheduledTaskCustomGroupFields = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
): Effect.Effect<{ readonly customGroup?: ThreadCustomGroup }> =>
  readScheduledTaskCustomGroup(sql, taskId).pipe(
    Effect.map((customGroup): { readonly customGroup?: ThreadCustomGroup } =>
      customGroup === null ? {} : { customGroup },
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read a scheduled task's custom group", { taskId, cause }).pipe(
        Effect.as({}),
      ),
    ),
  );

/**
 * Applies the `customGroup` of schedule_task or update_scheduled_task once the
 * task is saved: omitted keeps the stored label, null removes it, a label sets
 * it. `sql` is optional so service layers built without SQLite (tests) still
 * build; a label then fails instead of being dropped silently.
 */
export const saveScheduledTaskCustomGroupForMcp = (
  sql: Option.Option<SqlClient.SqlClient>,
  taskId: ScheduledTaskId,
  customGroup: ThreadCustomGroup | null | undefined,
): Effect.Effect<void, OrchestratorMcpFailure> => {
  if (customGroup === undefined) return Effect.void;
  if (Option.isNone(sql)) {
    return customGroup === null
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "This server cannot store a custom group for scheduled tasks.",
          }),
        );
  }
  return writeScheduledTaskCustomGroup(sql.value, taskId, customGroup).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `The scheduled task was saved, but its custom group was not: ${cause.message}`,
        }),
    ),
  );
};

/** Adds the task's label to an MCP task summary, so a caller can read back what it set. */
export const withScheduledTaskCustomGroup = (
  sql: Option.Option<SqlClient.SqlClient>,
  summary: OrchestratorMcpScheduledTask,
): Effect.Effect<OrchestratorMcpScheduledTask> =>
  Option.isNone(sql)
    ? Effect.succeed(summary)
    : scheduledTaskCustomGroupFields(sql.value, summary.scheduledTaskId).pipe(
        Effect.map((fields) => ({ ...summary, ...fields })),
      );
