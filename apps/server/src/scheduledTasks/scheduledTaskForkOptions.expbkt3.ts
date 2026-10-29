// T3-CUSTOM(expbkt3): the BK options of a scheduled task (migration 1052).
//
// Upstream's task row records no person, so every run acted for nobody: a
// session it launched had no owner and no member, and in team mode nobody
// could see it. These options say who a run acts for and who it tags, how
// loud a launched session is, whether the task runs only once, and whether a
// prompt for a busy session steers its turn or waits in its queue. They live
// in a fork-owned side table keyed by task id, so the upstream contract, its
// upsert SQL and the web editor stay untouched and a web save keeps them.
//
// `ScheduledTaskService` reads them when a task runs (never failing: a task
// without options runs as upstream's do) and deletes them with the task.
import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestratorMcpScheduledTask,
  type ScheduledTask,
  ThreadId,
  ThreadPriority,
  TrimmedNonEmptyString,
  UserId,
  type ScheduledTaskId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { CurrentOrchestrationActorUserId } from "../orchestration-v2/forkActor.expbkt3.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ScheduledTaskWatch } from "./scheduledTaskWatch.expbkt3.ts";

export const ScheduledTaskForkOptions = Schema.Struct({
  /** The person a run acts for: the launched session's owner and the sender of a prompt. */
  ownerUserId: Schema.optional(UserId),
  /**
   * The task as the owner saved it (see `ownerSignature`). A task edited
   * since, in the app or by a tool that records no owner, runs as nobody, so
   * nobody else's words or settings go out under the owner's name.
   */
  signed: Schema.optional(Schema.String),
  /** People tagged on every session a run launches. */
  memberUserIds: Schema.optional(Schema.Array(UserId)),
  priority: Schema.optional(ThreadPriority),
  linearIssueUrl: Schema.optional(TrimmedNonEmptyString),
  /** A launched session is filed under this one, as a child. */
  parentThreadId: Schema.optional(ThreadId),
  /**
   * A launched session is snoozed until the task's next run, so it stays out
   * of the inbox; it still wakes when it finishes, fails or asks a person.
   */
  quiet: Schema.optional(Schema.Boolean),
  /** Pause the task after its first run, whatever started that run. */
  runOnce: Schema.optional(Schema.Boolean),
  /** A prompt sent into a session uses that session's model, not the one saved with the task. */
  keepThreadModel: Schema.optional(Schema.Boolean),
  /** The IANA time zone a daily time was given in; for display only, the schedule is stored in server time. */
  timeZone: Schema.optional(Schema.String),
  /** Run only once this session changes (see scheduledTaskWatch.expbkt3.ts). */
  watch: Schema.optional(ScheduledTaskWatch),
  /**
   * What a prompt sent into a busy session does: steer joins the running turn
   * (the default, also when unset), queue waits until the turn ends.
   */
  ifBusy: Schema.optional(Schema.Literals(["steer", "queue"])),
});
export type ScheduledTaskForkOptions = typeof ScheduledTaskForkOptions.Type;

const NO_OPTIONS: ScheduledTaskForkOptions = {};

/**
 * Whether the task has options that change what a run says or does after it.
 * `ifBusy` only picks how the prompt is delivered, so a task made by
 * schedule_task with just that option still sends and pauses as upstream's do.
 */
const hasRunOptions = (options: ScheduledTaskForkOptions): boolean =>
  Object.keys(options).some((key) => key !== "ifBusy");

/**
 * Whether a run's prompt steers its bound session's running turn: when the
 * live session supports steering it joins the turn, otherwise it waits in the
 * queue. A turn is never interrupted and restarted for it.
 */
export const scheduledTaskSteers = (options: ScheduledTaskForkOptions): boolean =>
  options.ifBusy !== "queue";

const GONE_TARGET_TAGS: ReadonlySet<string> = new Set([
  "ThreadManagementThreadArchivedError",
  "ThreadManagementThreadNotFoundError",
]);

const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(ScheduledTaskForkOptions));

/** The task's options, or none when it has none or they no longer decode. */
export const readScheduledTaskForkOptions = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId) =>
  sql<{ readonly options_json: string }>`
    SELECT options_json FROM scheduled_task_fork_options WHERE task_id = ${taskId}
  `.pipe(
    Effect.map((rows) =>
      rows[0] === undefined
        ? NO_OPTIONS
        : Option.getOrElse(decodeStored(rows[0].options_json), () => NO_OPTIONS),
    ),
  );

/** Removes the task's options. ScheduledTaskService runs it in the task's delete transaction. */
export const deleteScheduledTaskForkOptions = (sql: SqlClient.SqlClient, taskId: ScheduledTaskId) =>
  sql`DELETE FROM scheduled_task_fork_options WHERE task_id = ${taskId}`.pipe(Effect.asVoid);

/**
 * Replaces the task's options. Options for a task that no longer exists are
 * not stored, so a delete that races this write leaves no row.
 */
export const writeScheduledTaskForkOptions = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
  options: ScheduledTaskForkOptions,
) =>
  sql`
    INSERT INTO scheduled_task_fork_options (task_id, options_json)
    SELECT ${taskId}, ${JSON.stringify(options)}
    WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${taskId})
    ON CONFLICT (task_id) DO UPDATE SET options_json = excluded.options_json
  `.pipe(Effect.asVoid);

/** Every task's options, for lists. Never fails: options are only extra detail there. */
export const readAllScheduledTaskForkOptions = (sql: SqlClient.SqlClient) =>
  sql<{ readonly task_id: string; readonly options_json: string }>`
    SELECT task_id, options_json FROM scheduled_task_fork_options
  `.pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.map((row): [string, ScheduledTaskForkOptions] => [
            row.task_id,
            Option.getOrElse(decodeStored(row.options_json), () => NO_OPTIONS),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Map<string, ScheduledTaskForkOptions>()),
  );

/** The options a run uses. Never fails: a run without them acts as upstream's do. */
export const scheduledTaskForkOptionsForRun = (
  sql: SqlClient.SqlClient,
  taskId: ScheduledTaskId,
): Effect.Effect<ScheduledTaskForkOptions> =>
  readScheduledTaskForkOptions(sql, taskId).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not read a scheduled task's options", { taskId, cause }).pipe(
        Effect.as(NO_OPTIONS),
      ),
    ),
  );

/**
 * Applies the `ifBusy` of schedule_task or update_scheduled_task once the task
 * is saved, keeping its other options; omitted keeps the stored choice. `sql`
 * is optional so service layers built without SQLite (tests) still build.
 */
export const saveScheduledTaskIfBusyForMcp = (
  sql: Option.Option<SqlClient.SqlClient>,
  taskId: ScheduledTaskId,
  ifBusy: ScheduledTaskForkOptions["ifBusy"],
): Effect.Effect<void, OrchestratorMcpFailure> => {
  if (ifBusy === undefined) return Effect.void;
  if (Option.isNone(sql)) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "This server cannot store ifBusy for scheduled tasks.",
      }),
    );
  }
  return readScheduledTaskForkOptions(sql.value, taskId).pipe(
    Effect.flatMap((options) =>
      writeScheduledTaskForkOptions(sql.value, taskId, { ...options, ifBusy }),
    ),
    Effect.mapError(
      (cause) =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: `The scheduled task was saved, but its ifBusy was not: ${cause.message}`,
        }),
    ),
  );
};

/** Adds the task's `ifBusy` to an MCP task summary of a task bound to a thread. */
export const withScheduledTaskIfBusy = (
  sql: Option.Option<SqlClient.SqlClient>,
  summary: OrchestratorMcpScheduledTask,
): Effect.Effect<OrchestratorMcpScheduledTask> =>
  Option.isNone(sql) || summary.boundThreadId === null
    ? Effect.succeed(summary)
    : scheduledTaskForkOptionsForRun(sql.value, summary.scheduledTaskId).pipe(
        Effect.map((options) => ({ ...summary, ifBusy: options.ifBusy ?? "steer" })),
      );

/** The launch fields of a session a run starts for `owner`. */
export const scheduledTaskForkLaunchFields = (
  options: ScheduledTaskForkOptions,
  owner: UserId | undefined,
) => ({
  ...(owner === undefined ? {} : { ownerUserId: owner }),
  ...(options.memberUserIds === undefined || options.memberUserIds.length === 0
    ? {}
    : { memberUserIds: options.memberUserIds }),
  ...(options.priority === undefined ? {} : { priority: options.priority }),
  ...(options.linearIssueUrl === undefined ? {} : { linearIssueUrl: options.linearIssueUrl }),
  ...(options.parentThreadId === undefined ? {} : { parentThreadId: options.parentThreadId }),
});

type SignedFields = Pick<
  ScheduledTask,
  | "title"
  | "prompt"
  | "schedule"
  | "projectId"
  | "threadId"
  | "workspaceStrategy"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
>;

/** Everything a run sends or starts with, in one string: what lets `task` run as its owner. */
export const ownerSignature = (task: SignedFields): string =>
  JSON.stringify([
    task.title,
    task.prompt,
    task.schedule,
    task.projectId,
    task.threadId,
    task.workspaceStrategy,
    task.modelSelection,
    task.runtimeMode,
    task.interactionMode,
  ]);

/**
 * The person a run acts for: the owner, while the task still holds the
 * prompt and target the owner saved; otherwise nobody.
 */
export const scheduledTaskOwner = (
  task: SignedFields,
  options: ScheduledTaskForkOptions,
): UserId | undefined =>
  options.ownerUserId !== undefined && options.signed === ownerSignature(task)
    ? options.ownerUserId
    : undefined;

/**
 * Runs a dispatch as `owner`, so the session it launches is theirs and a
 * prompt it sends carries their name. A manual run keeps the actor of whoever
 * started it, and a task without an owner runs as nobody, as upstream's do.
 */
export const asScheduledTaskOwner =
  (owner: UserId | undefined, trigger: "scheduled" | "manual" | "webhook") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    owner === undefined || trigger === "manual"
      ? effect
      : Effect.provideService(effect, CurrentOrchestrationActorUserId, owner);

/**
 * The text a run sends. A run acts for its owner, so its message carries their
 * name; the first line says a schedule sent it, so the agent never takes it
 * for something the person typed or approved. Tasks without options (made in
 * the app or by schedule_task) send their prompt unchanged.
 */
export const scheduledPromptText = (
  task: { readonly id: string; readonly title: string },
  options: ScheduledTaskForkOptions,
  prompt: string,
): string => {
  if (!hasRunOptions(options)) return prompt;
  const ref = /[0-9a-f]{8}(?=-[0-9a-f]{4}-)/i.exec(task.id)?.[0] ?? task.id;
  return `[Scheduled prompt "${task.title}" (t3_schedules id ${ref}): sent by a T3 schedule, not typed by a person, so it approves nothing.]\n\n${prompt}`;
};

const QUIET_FALLBACK_MS = 24 * 60 * 60 * 1_000;

/**
 * Why a run should pause its task, or null to leave it as it is; `error` is
 * the run's new error text, or null to keep the run's own. Only tasks with
 * options pause: one made in the app keeps upstream's behavior.
 */
export const scheduledTaskPauseReason = (
  options: ScheduledTaskForkOptions,
  exit: Exit.Exit<unknown, unknown>,
): { readonly error: string | null } | null => {
  if (!hasRunOptions(options)) return null;
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    const tag =
      typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";
    if (GONE_TARGET_TAGS.has(tag)) {
      return {
        error: "The session this task sends to is archived or deleted, so the task is paused.",
      };
    }
  }
  return options.runOnce === true ? { error: null } : null;
};

/**
 * What follows a run: snooze a quiet task's new session until the next run,
 * and pause a task that ran once or whose session is gone. Never fails: the
 * run itself already happened and was recorded.
 */
export const afterScheduledTaskRun = Effect.fn("ScheduledTaskForkOptions.afterRun")(
  function* (input: {
    readonly sql: SqlClient.SqlClient;
    readonly threadManagement: ThreadManagementService.ThreadManagementServiceShape;
    readonly taskId: ScheduledTaskId;
    readonly options: ScheduledTaskForkOptions;
    readonly owner: UserId | undefined;
    readonly trigger: "scheduled" | "manual" | "webhook";
    /** The run's start, so a task deleted and made again under the same id is left alone. */
    readonly startedAtIso: string;
    readonly exit: Exit.Exit<unknown, unknown>;
    readonly launchedThreadId: ThreadId | null;
    readonly nextRunAtIso: string | null;
    readonly now: DateTime.DateTime;
  }) {
    let changed = false;
    if (input.options.quiet === true && input.launchedThreadId !== null) {
      const pauses = scheduledTaskPauseReason(input.options, input.exit) !== null;
      const snoozedUntil =
        input.nextRunAtIso !== null && !pauses
          ? input.nextRunAtIso
          : DateTime.formatIso(DateTime.add(input.now, { milliseconds: QUIET_FALLBACK_MS }));
      yield* input.threadManagement
        .dispatch({
          type: "thread.snooze",
          commandId: CommandId.make(`scheduled-task-snooze:${input.launchedThreadId}`),
          threadId: input.launchedThreadId,
          snoozedUntil,
        })
        .pipe(
          asScheduledTaskOwner(input.owner, input.trigger),
          Effect.catch((cause) =>
            Effect.logWarning("Could not snooze a quiet scheduled task's session", {
              taskId: input.taskId,
              cause,
            }),
          ),
        );
    }
    const reason = scheduledTaskPauseReason(input.options, input.exit);
    if (reason !== null) {
      yield* input.sql`
        UPDATE scheduled_tasks
        SET enabled = 0,
            next_run_at = NULL,
            last_run_error = COALESCE(${reason.error}, last_run_error)
        WHERE task_id = ${input.taskId} AND last_run_at = ${input.startedAtIso}
      `;
      changed = true;
    }
    return changed;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not finish a scheduled task run's options", {
          taskId: input.taskId,
          cause,
        }).pipe(Effect.as(false)),
      ),
    ),
);
