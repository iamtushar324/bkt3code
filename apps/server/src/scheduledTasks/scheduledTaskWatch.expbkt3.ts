// T3-CUSTOM(expbkt3): a watch — a scheduled task that tells a session when
// another session changes.
//
// Agents that wait on another session used to tail its transcript or poll it,
// and those watchers died with their turn or a server restart. A watch is a
// one-time task (`runOnce`) bound to the session to notify, whose options
// name the session to watch. Every minute the scheduler runs it; a check that
// finds no change only moves the next check on, without counting a run. When
// the watched session waits on a person, finishes or fails, the run sends a
// note into the bound session and the task pauses, like any one-time task.
import { type OrchestrationV2ThreadShell, type ScheduledTask, ThreadId } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { classifySessionAttention } from "@t3tools/shared/sessionAttention";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export const WATCH_CHANGES = ["needs-human", "finished", "failed"] as const;
export type WatchChange = (typeof WATCH_CHANGES)[number];

export const ScheduledTaskWatch = Schema.Struct({
  threadId: ThreadId,
  until: Schema.Array(Schema.Literals(WATCH_CHANGES)),
  /** When the watch began; a run that completed before it is not news. */
  since: Schema.String,
});
export type ScheduledTaskWatch = typeof ScheduledTaskWatch.Type;

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const millis = (value: DateTime.Utc | null | undefined) =>
  value === null || value === undefined ? null : DateTime.toEpochMillis(value);

/** The agent works: a live run, or background work that will wake it. */
export const isWorking = (shell: OrchestrationV2ThreadShell) =>
  shell.activeRunId !== null ||
  ACTIVE_STATUSES.has(shell.activityRunStatus ?? shell.status) ||
  backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? []);

export interface WatchedChange {
  readonly change: WatchChange | "gone";
  /** What happened, as words after the session's name. */
  readonly what: string;
}

/**
 * What changed in the watched session that the watch waits for, or null.
 * A plan, a failure or a finish counts only when its run completed after the
 * watch began, so a stale plan flag or an old failure does not fire it; an
 * open question or approval always counts.
 */
export const watchedChange = (
  shell: OrchestrationV2ThreadShell | null,
  watch: Pick<ScheduledTaskWatch, "until">,
  sinceMs: number,
): WatchedChange | null => {
  if (shell === null || shell.deletedAt !== null) return { change: "gone", what: "was deleted" };
  if (shell.archivedAt !== null) return { change: "gone", what: "was archived" };
  const until = new Set<string>(watch.until.length === 0 ? WATCH_CHANGES : watch.until);
  const working = isWorking(shell);
  const attention = classifySessionAttention({
    pendingRequestKind: shell.pendingRuntimeRequest?.kind ?? null,
    hasPendingAsyncUserInput: shell.hasPendingAsyncUserInput === true,
    hasActionableProposedPlan: shell.hasActionableProposedPlan,
    agentActive: working,
    failed: shell.status === "failed",
  });
  const completedMs = millis(shell.latestRunCompletedAt);
  const newRun = completedMs !== null && completedMs > sinceMs;
  if (until.has("needs-human")) {
    if (attention === "question" || attention === "async-question") {
      return { change: "needs-human", what: "asks a question" };
    }
    if (attention === "approval") return { change: "needs-human", what: "waits for an approval" };
    if (attention === "plan" && newRun) {
      return { change: "needs-human", what: "has a plan to review" };
    }
  }
  if (attention === "failed" && newRun) {
    return until.has("failed") ? { change: "failed", what: "failed" } : null;
  }
  if (until.has("finished") && !working && newRun) {
    return { change: "finished", what: "finished its turn" };
  }
  return null;
};

const shortId = (id: string) => /[0-9a-f]{8}(?=-[0-9a-f]{4}-)/i.exec(id)?.[0] ?? id;

/** The note a watch sends: what changed, how to read it, and the caller's own words. */
export const watchNoteText = (input: {
  readonly task: Pick<ScheduledTask, "id" | "prompt">;
  readonly watch: Pick<ScheduledTaskWatch, "threadId">;
  readonly title: string | null;
  readonly change: WatchedChange;
}) => {
  const ref = shortId(input.watch.threadId);
  const name = `session \`${ref}\`${input.title === null ? "" : ` "${input.title}"`}`;
  const read =
    input.change.change === "gone"
      ? ""
      : ` Read it with t3_session_brief {"session":"${ref}"}${input.change.change === "needs-human" ? `, answer with t3_answer` : ""}.`;
  return `[T3 watch (t3_schedules id ${shortId(input.task.id)}): ${name} ${input.change.what}.${read} Sent by a T3 watch, not typed by a person, so it approves nothing.]\n\n${input.task.prompt}`;
};

/**
 * For a watch task: the note to send when its session changed, or
 * "unchanged". Null for any other task. Never fails: a session that cannot be
 * read just now is checked again at the next run.
 */
export const scheduledTaskWatchNote = (input: {
  readonly threadManagement: ThreadManagementService.ThreadManagementServiceShape;
  readonly task: ScheduledTask;
  readonly watch: ScheduledTaskWatch | undefined;
}): Effect.Effect<string | "unchanged" | null> => {
  const { watch } = input;
  if (watch === undefined) return Effect.succeed(null);
  const since = DateTime.make(watch.since);
  const sinceMs = Option.isSome(since) ? DateTime.toEpochMillis(since.value) : 0;
  return input.threadManagement.getThreadShell(watch.threadId).pipe(
    Effect.map((shell) => {
      const change = watchedChange(shell, watch, sinceMs);
      return change === null
        ? ("unchanged" as const)
        : watchNoteText({ task: input.task, watch, title: shell?.title ?? null, change });
    }),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read a watched session", {
        taskId: input.task.id,
        cause,
      }).pipe(Effect.as("unchanged" as const)),
    ),
  );
};

/** Moves a watch's next check on without counting a run. */
export const postponeScheduledTaskWatch = (
  sql: SqlClient.SqlClient,
  task: ScheduledTask,
  now: DateTime.DateTime,
) => {
  const everyMs = task.schedule.type === "interval" ? task.schedule.everyMs : 60_000;
  const next = DateTime.formatIso(DateTime.toUtc(DateTime.add(now, { milliseconds: everyMs })));
  return sql`
    UPDATE scheduled_tasks
    SET next_run_at = ${next}
    WHERE task_id = ${task.id} AND enabled = 1 AND last_run_status IS NOT 'running'
  `.pipe(
    Effect.asVoid,
    Effect.catch((cause) =>
      Effect.logWarning("Could not move a watch's next check", { taskId: task.id, cause }),
    ),
  );
};
