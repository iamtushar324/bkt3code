/**
 * T3-CUSTOM(expbkt3): t3_schedule and t3_schedules (see tools.ts).
 *
 * A schedule is upstream's scheduled task plus the fork's options for it
 * (scheduledTaskForkOptions.expbkt3.ts): the person its runs act for, the
 * tags and links of the sessions it starts, quiet, and run-once. By default a
 * schedule sends its prompt into a session as a queued message with that
 * session's own model; with a project it starts a new session on every run.
 *
 * A caller manages the schedules it owns, those that send into a session it
 * can see, and ownerless ones (made in the app or by schedule_task) in a
 * project it can use; an operator, or a client acting for no user, manages
 * all of them.
 */
import {
  type OrchestrationUser,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  ThreadCustomGroup,
  type UserId,
} from "@t3tools/contracts";
import { resolveNewThreadDefaults } from "@t3tools/shared/newThreadDefaults.expbkt3";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { Tool } from "effect/ai";

import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { ProviderRegistry } from "../../../provider/ProviderRegistry.ts";
import {
  readScheduledTaskCustomGroup,
  writeScheduledTaskCustomGroup,
} from "../../../scheduledTasks/scheduledTaskCustomGroup.expbkt3.ts";
import {
  ownerSignature,
  readAllScheduledTaskForkOptions,
  readScheduledTaskForkOptions,
  scheduledTaskOwner,
  writeScheduledTaskForkOptions,
  type ScheduledTaskForkOptions,
} from "../../../scheduledTasks/scheduledTaskForkOptions.expbkt3.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import {
  isWorking,
  WATCH_CHANGES,
  watchedChange,
  type WatchChange,
} from "../../../scheduledTasks/scheduledTaskWatch.expbkt3.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, assertTargetWithinLimits, type Caller } from "../../threadAccess.ts";
import {
  fail,
  loadAgentCaller,
  loadProjects,
  loadVisibleSessions,
  resolveProject,
  resolveSession,
  usableProjects,
  visibleTo,
  type ProjectSummary,
  type VisibleSessions,
} from "./context.ts";
import { modelSelectionFor, resolveModel } from "./models.ts";
import {
  commandIdFor,
  interactionModeFor,
  linkOrigin,
  loadPeople,
  personName,
  result,
} from "./support.ts";
import type { NotifyMeTool, ScheduleTool, SchedulesTool } from "./tools.ts";
import {
  callHint,
  cutText,
  isoFromMillis,
  oneLine,
  sessionLink,
  shortRef,
  type SessionShell,
} from "./view.ts";
import { describeSchedule, formatInstant, hasWhen, resolveWhen } from "./when.ts";

const decodeGroup = Schema.decodeUnknownOption(ThreadCustomGroup);
const LINEAR_ISSUE_URL = /^https:\/\/linear\.app\/[^/]+\/issue\/[A-Za-z0-9]+-\d+/;

const unavailable = () =>
  fail("unavailable", "T3 Code could not read the schedules just now. Try again in a moment.");

interface ScheduleView {
  readonly task: ScheduledTask;
  readonly options: ScheduledTaskForkOptions;
}

interface ScheduleContext {
  readonly caller: Caller;
  readonly nowMs: number;
  readonly origin: string | undefined;
  readonly projects: ReadonlyMap<string, ProjectSummary>;
  /** Sessions the schedules send into, by id, when the caller can see them. */
  readonly sessions: ReadonlyMap<string, SessionShell>;
  readonly people: ReadonlyMap<string, OrchestrationUser>;
  /** The caller's active sessions, read once per call. */
  readonly visible: VisibleSessions;
}

const sqlClient = Effect.serviceOption(SqlClient.SqlClient).pipe(
  Effect.flatMap((sql) =>
    Option.isSome(sql)
      ? Effect.succeed(sql.value)
      : Effect.fail(fail("unavailable", "This server cannot store schedule options.")),
  ),
);

/** Every schedule the caller may manage, newest next run first. */
const loadSchedules = Effect.fn("agentToolkit.loadSchedules")(function* (
  caller: Caller,
  projects: ReadonlyMap<string, ProjectSummary>,
) {
  const service = yield* ScheduledTaskService;
  const { tasks } = yield* service.list().pipe(Effect.mapError(unavailable));
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const allOptions = Option.isNone(sql)
    ? new Map<string, ScheduledTaskForkOptions>()
    : yield* readAllScheduledTaskForkOptions(sql.value);
  const { scope } = caller;
  const everything =
    scope.actorUserId === null || McpInvocationContext.isExternalMcpOperator(scope);
  const visible = visibleTo(scope);
  const sessions = yield* loadVisibleSessions(caller, { archived: false });
  const shells = new Map<string, SessionShell>(sessions.active.map((shell) => [shell.id, shell]));
  // A schedule may send into an archived session; read those few directly.
  for (const task of tasks) {
    if (task.threadId === null || shells.has(task.threadId)) continue;
    const shell = yield* caller.threads
      .getThreadShell(task.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell !== null && shell.deletedAt === null && visible(shell)) shells.set(shell.id, shell);
  }
  const usable = new Set(usableProjects(scope, projects, sessions.active).map((p) => p.id));
  const views = tasks
    .map((task): ScheduleView => ({ task, options: allOptions.get(task.id) ?? {} }))
    .filter(
      ({ task, options }) =>
        everything ||
        (options.ownerUserId !== undefined && options.ownerUserId === scope.actorUserId) ||
        (task.threadId !== null && shells.has(task.threadId)) ||
        (options.ownerUserId === undefined && task.threadId === null && usable.has(task.projectId)),
    )
    .toSorted(
      (left, right) =>
        (left.task.nextRunAt ?? "9999").localeCompare(right.task.nextRunAt ?? "9999") ||
        right.task.updatedAt.localeCompare(left.task.updatedAt),
    );
  return { views, shells, sessions };
});

const scheduleContext = Effect.fn("agentToolkit.scheduleContext")(function* (caller: Caller) {
  const nowMs = yield* Clock.currentTimeMillis;
  const origin = yield* linkOrigin(caller.scope);
  const projects = yield* loadProjects();
  const people = yield* loadPeople();
  const { views, shells, sessions } = yield* loadSchedules(caller, projects);
  return {
    views,
    context: {
      caller,
      nowMs,
      origin,
      projects,
      sessions: shells,
      people,
      visible: sessions,
    } satisfies ScheduleContext,
  };
});

/** The one schedule `ref` names among those the caller manages. */
const findSchedule = (views: ReadonlyArray<ScheduleView>, ref: string | undefined) => {
  const wanted = ref?.trim() ?? "";
  if (wanted.length === 0) {
    return Effect.fail(fail("id_required", "Pass id: the schedule, from t3_schedules."));
  }
  const lower = wanted.toLowerCase();
  const exact = views.filter((view) => view.task.id === wanted);
  const matches =
    exact.length > 0
      ? exact
      : views.filter(
          (view) =>
            (lower.length >= 4 && shortRef(view.task.id).startsWith(lower)) ||
            view.task.title.toLowerCase() === lower,
        );
  const loose =
    matches.length > 0
      ? matches
      : views.filter((view) => view.task.title.toLowerCase().includes(lower));
  const [first] = loose;
  if (first !== undefined && loose.length === 1) return Effect.succeed(first);
  return Effect.fail(
    first === undefined
      ? fail(
          "schedule_not_found",
          `No schedule you can manage matches "${wanted}". t3_schedules lists them.`,
        )
      : fail(
          "schedule_ambiguous",
          `"${wanted}" matches ${loose.length} schedules. Pass one of these ids:\n${loose
            .map((view) => `- \`${shortRef(view.task.id)}\` ${view.task.title}`)
            .join("\n")}`,
        ),
  );
};

const nameOf = (context: ScheduleContext, userId: string | undefined) =>
  userId === undefined ? null : personName(context.people, userId);

/** Where a schedule's runs go, in words and as data. */
const targetOf = (view: ScheduleView, context: ScheduleContext) => {
  const { task, options } = view;
  if (task.threadId !== null) {
    const shell = context.sessions.get(task.threadId);
    const ref = shortRef(task.threadId);
    return {
      text: `into session \`${ref}\`${shell === undefined ? "" : ` ${oneLine(shell.title, 60)}`}${shell?.archivedAt != null ? " (archived)" : ""}`,
      data: {
        type: "session" as const,
        sessionId: task.threadId,
        ref,
        title: shell?.title ?? null,
        link: sessionLink(context.origin, context.caller.scope.environmentId, task.threadId),
      },
    };
  }
  const project = context.projects.get(task.projectId)?.title ?? task.projectId;
  const tagged = (options.memberUserIds ?? []).map((id) => nameOf(context, id) ?? id);
  const extras = [
    options.quiet === true ? "quiet" : null,
    options.priority === undefined || options.priority === 0 ? null : `P${options.priority}`,
    tagged.length === 0 ? null : `tags ${tagged.join(", ")}`,
    options.linearIssueUrl === undefined ? null : options.linearIssueUrl,
    options.parentThreadId === undefined ? null : `under \`${shortRef(options.parentThreadId)}\``,
  ].filter((part): part is string => part !== null);
  return {
    text: `new session in ${project}${extras.length === 0 ? "" : ` (${extras.join(", ")})`}`,
    data: {
      type: "new-session" as const,
      projectId: task.projectId,
      project,
      model: task.modelSelection.model,
      mode: task.interactionMode === "plan" ? "plan" : "build",
      quiet: options.quiet === true,
      priority: options.priority ?? null,
      tagged,
      linear: options.linearIssueUrl ?? null,
      parentSessionId: options.parentThreadId ?? null,
    },
  };
};

const webhookUrlOf = (task: ScheduledTask, context: ScheduleContext) =>
  task.webhook === undefined
    ? null
    : (task.webhook.url ??
      (context.origin === undefined ? task.webhook.path : `${context.origin}${task.webhook.path}`));

/** Whether the caller may see a webhook URL: its token starts runs at the task's modes. */
const mayRun = (task: ScheduledTask, context: ScheduleContext) =>
  assertLiveCaller(context.caller).pipe(
    Effect.andThen(assertTargetWithinLimits(context.caller.limits, task)),
    Effect.exit,
    Effect.map(Exit.isSuccess),
  );

const stateOf = (view: ScheduleView) =>
  view.task.enabled
    ? "active"
    : view.options.runOnce === true && view.task.lastRunStatus === "succeeded"
      ? "done"
      : "paused";

const WATCH_WORDS: Record<WatchChange, string> = {
  "needs-human": "waits on a person",
  finished: "finishes",
  failed: "fails",
};

const watchWords = (until: ReadonlyArray<WatchChange>) => {
  const words = (until.length === 0 ? WATCH_CHANGES : until).map((change) => WATCH_WORDS[change]);
  return words.length <= 1
    ? (words[0] ?? "")
    : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
};

const renderSchedule = Effect.fn("agentToolkit.renderSchedule")(function* (
  view: ScheduleView,
  context: ScheduleContext,
) {
  const { task, options } = view;
  const ref = shortRef(task.id);
  const watched =
    options.watch === undefined ? undefined : context.sessions.get(options.watch.threadId);
  const when =
    options.watch === undefined
      ? describeSchedule(task.schedule, {
          runOnce: options.runOnce,
          timeZone: options.timeZone,
          nowMs: context.nowMs,
        })
      : `when session \`${shortRef(options.watch.threadId)}\`${watched === undefined ? "" : ` ${oneLine(watched.title, 50)}`} ${watchWords(options.watch.until)}, sends a note`;
  const target = targetOf(view, context);
  const state = stateOf(view);
  const next =
    state === "active" && options.watch !== undefined
      ? "checks every minute"
      : state === "active"
        ? task.nextRunAt === null
          ? task.schedule.type === "webhook"
            ? "waits for a request"
            : "no next run"
          : `next ${formatInstant(task.nextRunAt, options.timeZone)}`
        : state === "done"
          ? options.watch === undefined
            ? "done: it ran once"
            : "done: the note was sent"
          : "paused";
  const last =
    task.lastRunAt === null
      ? "never ran"
      : `last ${task.lastRunStatus} ${formatInstant(task.lastRunAt, options.timeZone)}`;
  // An owner counts only while the task is as they saved it.
  const actingOwner = scheduledTaskOwner(task, options);
  const owner =
    actingOwner === undefined
      ? options.ownerUserId === undefined
        ? null
        : "nobody (edited outside t3_schedule; save it again to run as you)"
      : nameOf(context, actingOwner);
  const showUrl = task.webhook !== undefined && (yield* mayRun(task, context));
  const webhookUrl = showUrl ? webhookUrlOf(task, context) : null;
  const lines = [
    `- \`${ref}\` **${oneLine(task.title, 80)}** · ${when} ${target.text}`,
    `  ${next} · ${last}${task.runCount > 0 ? ` · ${task.runCount} run${task.runCount === 1 ? "" : "s"}` : ""}${owner === null ? "" : ` · for ${owner}`}`,
    ...(task.lastRunStatus === "failed" && task.lastRunError !== null
      ? [`  Last error: ${oneLine(task.lastRunError, 200)}`]
      : []),
    `  Prompt: ${oneLine(task.prompt, 160)}`,
    ...(webhookUrl === null ? [] : [`  Webhook URL: ${webhookUrl}`]),
  ];
  return {
    markdown: lines.join("\n"),
    data: {
      id: task.id,
      ref,
      title: task.title,
      prompt: cutText(task.prompt, 4_000),
      state,
      when,
      schedule: task.schedule,
      runOnce: options.runOnce === true,
      timeZone: options.timeZone ?? null,
      watch:
        options.watch === undefined
          ? null
          : { sessionId: options.watch.threadId, until: options.watch.until },
      target: target.data,
      nextRunAt: task.nextRunAt,
      lastRunAt: task.lastRunAt,
      lastRunStatus: task.lastRunStatus,
      lastRunError: task.lastRunError,
      runCount: task.runCount,
      owner,
      ownerUserId: actingOwner ?? null,
      webhookUrl,
    },
  };
});

export const listSchedules = Effect.fn("agentToolkit.listSchedules")(function* (
  input: Tool.Parameters<typeof SchedulesTool>,
) {
  const caller = yield* loadAgentCaller("t3.control");
  const { views, context } = yield* scheduleContext(caller);
  const session =
    input.session === undefined
      ? undefined
      : yield* resolveSession({
          caller,
          ref: input.session,
          nowMs: context.nowMs,
          sessions: context.visible,
        });
  const project =
    input.project === undefined
      ? undefined
      : yield* resolveProject(input.project, [...context.projects.values()]);
  const shown = views.filter(
    (view) =>
      (session === undefined || view.task.threadId === session.id) &&
      (project === undefined || view.task.projectId === project.id) &&
      (input.includePaused !== false || view.task.enabled),
  );
  const rendered = yield* Effect.forEach(shown, (view) => renderSchedule(view, context));
  const scopeText = [
    session === undefined ? null : `sending into \`${shortRef(session.id)}\``,
    project === undefined ? null : `in ${project.title}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const heading = `## ${shown.length} schedule${shown.length === 1 ? "" : "s"}${scopeText.length === 0 ? "" : ` ${scopeText}`}`;
  const markdown =
    shown.length === 0
      ? `${heading}\n\nNone. Make one with ${callHint("t3_schedule", { prompt: "…", in: "30m" })}.`
      : [
          heading,
          "",
          ...rendered.map((entry) => entry.markdown),
          "",
          `Change one with ${callHint("t3_schedule", { action: "pause", id: shortRef(shown[0]?.task.id ?? "") })} (or update, resume, delete, run_now).`,
        ].join("\n");
  return result(markdown, { schedules: rendered.map((entry) => entry.data) });
});

const NEW_SESSION_OPTIONS = [
  "model",
  "effort",
  "mode",
  "workspace",
  "group",
  "tag",
  "parent",
  "priority",
  "linear",
  "quiet",
] as const;

type ScheduleInput = Tool.Parameters<typeof ScheduleTool>;

const givenNewSessionOptions = (input: ScheduleInput) =>
  NEW_SESSION_OPTIONS.filter((key) => input[key] !== undefined);

/** People by email or id, as user ids. */
const resolvePeople = (
  people: ReadonlyMap<string, OrchestrationUser>,
  entries: ReadonlyArray<string>,
) => {
  const ids: Array<UserId> = [];
  for (const entry of entries) {
    const wanted = entry.trim().toLowerCase();
    if (wanted.length === 0) continue;
    const match = [...people.values()].find(
      (person) => person.id.toLowerCase() === wanted || person.email?.toLowerCase() === wanted,
    );
    if (match === undefined) {
      return Effect.fail(
        fail("person_not_found", `"${entry}" is not a T3 user. Pass an email or a T3 user id.`),
      );
    }
    ids.push(match.id);
  }
  return Effect.succeed([...new Set(ids)]);
};

/** The workspace each new session of a schedule starts in. */
const workspaceStrategyFor = Effect.fn("agentToolkit.workspaceStrategyFor")(function* (
  workspace: string | undefined,
  envMode: string | null | undefined,
  workspaceRoot: string,
) {
  const value = workspace?.trim() ?? "";
  if (value === "project-root" || value === "local" || value === "root") {
    return { type: "root" as const };
  }
  if (value.length > 0 && value !== "new-worktree") {
    return { type: "existing_worktree" as const, worktreePath: value };
  }
  if (value.length === 0 && envMode === "local") return { type: "root" as const };
  // A new worktree starts from the branch the project root has checked out.
  const status = yield* (yield* GitWorkflowService)
    .localStatus({ cwd: workspaceRoot })
    .pipe(Effect.option);
  const baseRef = Option.isSome(status) ? (status.value.refName ?? "main") : "main";
  return { type: "worktree" as const, baseRef, startFromOrigin: true };
});

/** The model, modes and workspace of the sessions a schedule starts in `project`. */
const newSessionSettings = Effect.fn("agentToolkit.newSessionSettings")(function* (
  input: ScheduleInput,
  caller: Caller,
  started: McpToolAccess.StartedModes,
  project: ProjectSummary,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => fail("unavailable", "T3 Code could not read its settings just now.")),
  );
  const snapshot = yield* (yield* Project.ProjectService).snapshot.pipe(
    Effect.mapError(() => fail("unavailable", "T3 Code could not read the projects just now.")),
  );
  const record = snapshot.projects.find((candidate) => candidate.id === project.id) ?? null;
  const defaults = resolveNewThreadDefaults(settings, project.id, record);
  let modelSelection = defaults.modelSelection ?? settings.defaultThreadModelSelection;
  if (input.model !== undefined) {
    const providers = yield* (yield* ProviderRegistry).getProviders;
    const resolved = resolveModel(input.model, providers);
    if (Result.isFailure(resolved)) return yield* fail("model_not_found", resolved.failure);
    const selection = modelSelectionFor(resolved.success, input.effort);
    if (Result.isFailure(selection)) return yield* fail("invalid_effort", selection.failure);
    modelSelection = selection.success;
  } else if (input.effort !== undefined) {
    return yield* fail("model_required", 'Pass model with effort, for example model: "opus".');
  }
  let runtimeMode: RuntimeMode = defaults.runtimeMode;
  let interactionMode: ProviderInteractionMode =
    interactionModeFor(input.mode) ?? defaults.interactionMode;
  // A saved default broader than this caller may start falls back to the
  // caller's own modes, as t3_start_session does.
  const within = yield* Effect.exit(
    assertTargetWithinLimits(caller.limits, { runtimeMode, interactionMode }),
  );
  if (Exit.isFailure(within)) {
    runtimeMode = started.runtimeMode;
    interactionMode = interactionModeFor(input.mode) ?? started.interactionMode;
  }
  const workspaceStrategy = yield* workspaceStrategyFor(
    input.workspace,
    defaults.envMode,
    project.workspaceRoot,
  );
  return { modelSelection, runtimeMode, interactionMode, workspaceStrategy };
});

/** The options a schedule's new sessions take from `input`, merged over `base`. */
const newSessionOptions = Effect.fn("agentToolkit.newSessionOptions")(function* (
  input: ScheduleInput,
  context: ScheduleContext,
  base: ScheduledTaskForkOptions,
) {
  const { caller, nowMs } = context;
  let options: ScheduledTaskForkOptions = base;
  if (input.tag !== undefined) {
    const memberUserIds = yield* resolvePeople(context.people, input.tag);
    options = { ...options, memberUserIds };
  }
  if (input.parent !== undefined) {
    const parent = yield* resolveSession({
      caller,
      ref: input.parent,
      nowMs,
      sessions: context.visible,
    });
    options = { ...options, parentThreadId: parent.id };
  }
  if (input.priority !== undefined) {
    options = { ...options, priority: input.priority };
  }
  if (input.linear !== undefined) {
    const url = input.linear.trim();
    if (!LINEAR_ISSUE_URL.test(url)) {
      return yield* fail(
        "invalid_linear",
        "Pass linear as the issue URL, such as https://linear.app/team/issue/TEC-1488.",
      );
    }
    options = { ...options, linearIssueUrl: url };
  }
  if (input.quiet !== undefined) options = { ...options, quiet: input.quiet };
  let group: ThreadCustomGroup | null | undefined;
  if (input.group !== undefined) {
    const trimmed = input.group.trim();
    if (trimmed.length === 0) group = null;
    else {
      const decoded = decodeGroup(trimmed);
      if (Option.isNone(decoded)) {
        return yield* fail("invalid_group", "group must be a short name, up to 64 characters.");
      }
      group = decoded.value;
    }
  }
  return { options, group };
});

/** Run-once and the time zone follow a new `when`; everything else stays. */
const withWhenOptions = (
  options: ScheduledTaskForkOptions,
  when: { readonly runOnce: boolean; readonly timeZone: string | undefined },
): ScheduledTaskForkOptions => {
  const rest: { -readonly [Key in keyof ScheduledTaskForkOptions]: ScheduledTaskForkOptions[Key] } =
    { ...options };
  delete rest.runOnce;
  delete rest.timeZone;
  return {
    ...rest,
    ...(when.runOnce ? { runOnce: true } : {}),
    ...(when.timeZone === undefined ? {} : { timeZone: when.timeZone }),
  };
};

const saveOptions = Effect.fn("agentToolkit.saveScheduleOptions")(function* (
  taskId: ScheduledTask["id"],
  options: ScheduledTaskForkOptions,
  group: ThreadCustomGroup | null | undefined,
  whenFailed = "The schedule was saved, but its options were not",
) {
  const sql = yield* sqlClient;
  const saveFailed = (cause: { readonly message: string }) =>
    fail("schedule_failed", `${whenFailed}: ${cause.message}`);
  yield* writeScheduledTaskForkOptions(sql, taskId, options).pipe(Effect.mapError(saveFailed));
  if (group !== undefined) {
    yield* writeScheduledTaskCustomGroup(sql, taskId, group).pipe(Effect.mapError(saveFailed));
  }
});

/**
 * Saves a new schedule so it never runs without its options: it is made
 * paused, takes its options, signed by its owner, and only then starts. A
 * failed options write deletes it again.
 */
const saveNewSchedule = Effect.fn("agentToolkit.saveNewSchedule")(function* (
  upsert: ScheduledTaskUpsertInput,
  options: ScheduledTaskForkOptions,
  group: ThreadCustomGroup | null | undefined,
) {
  const service = yield* ScheduledTaskService;
  const failed = (error: { readonly message: string }) => fail("schedule_failed", error.message);
  // A retry with the same clientRequestId finds what the first call made and
  // changes nothing: no clock reset, and a finished one-time run stays done.
  if (upsert.commandId !== undefined) {
    const id = `scheduled-task:${upsert.commandId}`;
    const { tasks } = yield* service.list().pipe(Effect.mapError(failed));
    const existing = tasks.find((task) => task.id === id);
    if (existing !== undefined) {
      const sql = yield* sqlClient;
      const stored = yield* readScheduledTaskForkOptions(sql, existing.id).pipe(
        Effect.orElseSucceed((): ScheduledTaskForkOptions => ({})),
      );
      return { task: existing, options: stored };
    }
  }
  const { task: draft } = yield* service
    .upsert({ ...upsert, enabled: false })
    .pipe(Effect.mapError(failed));
  const removeDraft = service.delete({ id: draft.id }).pipe(Effect.ignore);
  const signed: ScheduledTaskForkOptions =
    options.ownerUserId === undefined ? options : { ...options, signed: ownerSignature(draft) };
  yield* saveOptions(draft.id, signed, group, "The schedule was not saved").pipe(
    Effect.tapError(() => removeDraft),
  );
  const { task } = yield* service.setEnabled({ id: draft.id, enabled: true }).pipe(
    Effect.mapError(failed),
    Effect.tapError(() => removeDraft),
  );
  return { task, options: signed };
});

const createSchedule = Effect.fn("agentToolkit.createSchedule")(function* (
  input: ScheduleInput,
  started: McpToolAccess.StartedModes,
  context: ScheduleContext,
) {
  const { caller, nowMs } = context;
  const { scope } = caller;
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length === 0) {
    return yield* fail("prompt_required", "Pass prompt: what to send on each run.");
  }
  const when = resolveWhen(input, nowMs);
  if (Result.isFailure(when)) return yield* fail("invalid_when", when.failure);
  if (input.session !== undefined && input.project !== undefined) {
    return yield* fail(
      "target_conflict",
      "Pass session (send into it) or project (start a new session on each run), not both.",
    );
  }
  yield* sqlClient;
  const title =
    input.title?.trim() || oneLine(prompt.split("\n")[0] ?? prompt, 80) || "Scheduled prompt";
  const createdBy = scope.thread === undefined ? ("user" as const) : ("agent" as const);
  let upsert: ScheduledTaskUpsertInput;
  let options: ScheduledTaskForkOptions;
  let group: ThreadCustomGroup | null | undefined;
  let target: string;
  if (input.project === undefined) {
    const misplaced = givenNewSessionOptions(input);
    if (misplaced.length > 0) {
      return yield* fail(
        "new_session_option",
        `${misplaced.join(", ")} ${misplaced.length === 1 ? "applies" : "apply"} to new sessions. Pass project to start a new session on each run, or leave them out to send into a session.`,
      );
    }
    const shell = yield* resolveSession({
      caller,
      ref: input.session,
      nowMs,
      sessions: context.visible,
    });
    if (shell.archivedAt !== null) {
      return yield* fail(
        "session_archived",
        `Session ${shortRef(shell.id)} is archived. Unarchive it in the app first.`,
      );
    }
    yield* assertTargetWithinLimits(caller.limits, shell);
    target = shell.id;
    upsert = {
      title,
      prompt,
      enabled: true,
      schedule: when.success.schedule,
      projectId: shell.projectId,
      threadId: shell.id,
      workspaceStrategy: { type: "root" },
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      createdBy,
      creationSource: "mcp",
    };
    options = withWhenOptions(
      {
        ...(scope.actorUserId === null ? {} : { ownerUserId: scope.actorUserId }),
        keepThreadModel: true,
      },
      when.success,
    );
  } else {
    if (!McpInvocationContext.canCreateMcpSessions(scope)) {
      return yield* fail(
        "capability_denied",
        "Starting sessions needs a user-bound credential or an operator client. Send into a session instead, or ask the person who approved this client for more access.",
      );
    }
    const project = yield* resolveProject(
      input.project,
      usableProjects(scope, context.projects, context.visible.active),
    );
    const settings = yield* newSessionSettings(input, caller, started, project);
    // Runs act for the person this caller acts for; a caller acting for
    // nobody makes a schedule that runs as nobody.
    const owner = scope.actorUserId;
    const extra = yield* newSessionOptions(
      input,
      context,
      withWhenOptions(owner === null ? {} : { ownerUserId: owner }, when.success),
    );
    options = extra.options;
    group = extra.group;
    target = project.id;
    upsert = {
      title,
      prompt,
      enabled: true,
      schedule: when.success.schedule,
      projectId: project.id,
      threadId: null,
      ...settings,
      createdBy,
      creationSource: "mcp",
    };
  }
  const commandId =
    input.clientRequestId === undefined
      ? undefined
      : yield* commandIdFor(scope, "schedule", target, input.clientRequestId);
  const saved = yield* saveNewSchedule(
    { ...upsert, ...(commandId === undefined ? {} : { commandId }) },
    options,
    group,
  );
  const { task } = saved;
  return yield* reportSchedule("Scheduled", saved, context, [
    task.webhook === undefined
      ? `Next: ${callHint("t3_schedules", {})} to see it, or ${callHint("t3_schedule", { action: "run_now", id: shortRef(task.id) })} to try it now.`
      : `Next: send a request to the webhook URL to run it; ${callHint("t3_schedules", {})} shows it again.`,
  ]);
});

/** The schedule as it is now, with a heading and next steps. */
const reportSchedule = Effect.fn("agentToolkit.reportSchedule")(function* (
  heading: string,
  view: ScheduleView,
  context: ScheduleContext,
  next: ReadonlyArray<string>,
) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const group =
    Option.isNone(sql) || view.task.threadId !== null
      ? null
      : yield* readScheduledTaskCustomGroup(sql.value, view.task.id).pipe(
          Effect.orElseSucceed(() => null),
        );
  const rendered = yield* renderSchedule(view, context);
  return result(
    [
      `## ${heading}: \`${shortRef(view.task.id)}\` ${oneLine(view.task.title, 80)}`,
      rendered.markdown,
      ...(group === null ? [] : [`  Group: ${group}`]),
      "",
      ...next,
    ].join("\n"),
    { ...rendered.data, group },
  );
});

const updateSchedule = Effect.fn("agentToolkit.updateSchedule")(function* (
  input: ScheduleInput,
  started: McpToolAccess.StartedModes,
  view: ScheduleView,
  context: ScheduleContext,
) {
  const { task } = view;
  if (input.session !== undefined || input.project !== undefined) {
    return yield* fail(
      "target_change",
      "A schedule keeps where it sends. To move it, delete it and make a new one.",
    );
  }
  const misplaced = givenNewSessionOptions(input);
  if (task.threadId !== null && misplaced.length > 0) {
    return yield* fail(
      "new_session_option",
      `${misplaced.join(", ")} ${misplaced.length === 1 ? "applies" : "apply"} only to schedules that start new sessions; this one sends into a session.`,
    );
  }
  yield* assertWithinModes(view, context);
  if (view.options.watch !== undefined && hasWhen(input)) {
    return yield* fail(
      "watch_has_no_time",
      "A watch runs when its session changes, not on a clock. Delete it and use t3_schedule for a timed prompt.",
    );
  }
  const when = hasWhen(input) ? resolveWhen(input, context.nowMs) : undefined;
  if (when !== undefined && Result.isFailure(when)) {
    return yield* fail("invalid_when", when.failure);
  }
  const prompt = input.prompt?.trim();
  if (prompt !== undefined && prompt.length === 0) {
    return yield* fail("prompt_required", "prompt cannot be empty.");
  }
  let options: ScheduledTaskForkOptions =
    when === undefined ? view.options : withWhenOptions(view.options, when.success);
  let group: ThreadCustomGroup | null | undefined;
  let settings: Partial<
    Pick<ScheduledTaskUpsertInput, "modelSelection" | "runtimeMode" | "interactionMode">
  > = {};
  if (task.threadId === null && misplaced.length > 0) {
    const extra = yield* newSessionOptions(input, context, options);
    options = extra.options;
    group = extra.group;
    if (input.model !== undefined || input.mode !== undefined) {
      const project = context.projects.get(task.projectId);
      if (project === undefined) {
        return yield* fail("project_not_found", "The schedule's project no longer exists.");
      }
      const next = yield* newSessionSettings(input, context.caller, started, project);
      settings = {
        ...(input.model === undefined ? {} : { modelSelection: next.modelSelection }),
        ...(input.mode === undefined
          ? {}
          : { runtimeMode: next.runtimeMode, interactionMode: next.interactionMode }),
      };
    }
  }
  const service = yield* ScheduledTaskService;
  const { task: saved } = yield* service
    .upsert({
      id: task.id,
      requireExisting: true,
      title: input.title?.trim() || task.title,
      prompt: prompt ?? task.prompt,
      // A new time brings a paused or finished schedule back.
      enabled: when === undefined ? task.enabled : true,
      schedule: when === undefined ? task.schedule : when.success.schedule,
      projectId: task.projectId,
      threadId: task.threadId,
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: settings.modelSelection ?? task.modelSelection,
      runtimeMode: settings.runtimeMode ?? task.runtimeMode,
      interactionMode: settings.interactionMode ?? task.interactionMode,
      createdBy: task.createdBy,
      creationSource: task.creationSource,
    })
    .pipe(Effect.mapError((error) => fail("schedule_failed", error.message)));
  // The person who saves the prompt is the person its runs act for.
  const { ownerUserId: _formerOwner, signed: _formerSigned, ...unowned } = options;
  const owned: ScheduledTaskForkOptions =
    context.caller.scope.actorUserId === null
      ? unowned
      : {
          ...unowned,
          ownerUserId: context.caller.scope.actorUserId,
          signed: ownerSignature(saved),
        };
  yield* saveOptions(saved.id, owned, group);
  return yield* reportSchedule("Updated", { task: saved, options: owned }, context, []);
});

/**
 * A caller changes or runs a schedule only within its own modes: the modes
 * the schedule starts sessions at, and those of the session it sends into
 * now, which that session's user may have raised since it was saved.
 */
const assertWithinModes = Effect.fn("agentToolkit.assertScheduleWithinModes")(function* (
  view: ScheduleView,
  context: ScheduleContext,
) {
  const { caller } = context;
  yield* assertTargetWithinLimits(caller.limits, view.task);
  if (view.task.threadId === null) return;
  // Fails closed: a session that cannot be read just now is not assumed safe.
  const bound =
    context.sessions.get(view.task.threadId) ??
    (yield* caller.threads
      .getThreadShell(view.task.threadId)
      .pipe(
        Effect.mapError(() =>
          fail("unavailable", "T3 Code could not read the schedule's session just now. Try again."),
        ),
      ));
  if (bound !== null && bound.deletedAt === null) {
    yield* assertTargetWithinLimits(caller.limits, bound);
  }
});

export const schedule = Effect.fn("agentToolkit.schedule")(function* (
  input: ScheduleInput,
  started: McpToolAccess.StartedModes,
) {
  const caller = yield* loadAgentCaller("t3.control");
  const { views, context } = yield* scheduleContext(caller);
  const action = input.action ?? "create";
  if (action === "create") {
    if (input.id !== undefined) {
      return yield* fail(
        "id_with_create",
        'Pass action: "update" to change the schedule id names, or leave id out to make a new one.',
      );
    }
    return yield* createSchedule(input, started, context);
  }
  const view = yield* findSchedule(views, input.id);
  const service = yield* ScheduledTaskService;
  const ref = shortRef(view.task.id);
  const failed = (error: { readonly message: string }) => fail("schedule_failed", error.message);
  switch (action) {
    case "update":
      return yield* updateSchedule(input, started, view, context);
    case "pause":
    case "resume": {
      if (action === "resume") yield* assertWithinModes(view, context);
      const { task } = yield* service
        .setEnabled({ id: view.task.id, enabled: action === "resume" })
        .pipe(Effect.mapError(failed));
      // Whoever turns a schedule back on is who its runs act for from now on.
      const actor = context.caller.scope.actorUserId;
      const options =
        action === "resume" && actor !== null && scheduledTaskOwner(task, view.options) !== actor
          ? { ...view.options, ownerUserId: actor, signed: ownerSignature(task) }
          : view.options;
      if (options !== view.options) yield* saveOptions(task.id, options, undefined);
      return yield* reportSchedule(
        action === "pause" ? "Paused" : "Resumed",
        { task, options },
        context,
        [],
      );
    }
    case "delete": {
      yield* assertWithinModes(view, context);
      yield* service.delete({ id: view.task.id }).pipe(Effect.mapError(failed));
      return result(
        `## Deleted: \`${ref}\` ${oneLine(view.task.title, 80)}\n\nIt will not run again.`,
        {
          id: view.task.id,
          ref,
          deleted: true,
        },
      );
    }
    case "run_now": {
      if (view.task.schedule.type === "webhook") {
        return yield* fail(
          "webhook_schedule",
          "A webhook schedule runs when its URL receives a request; send one to run it.",
        );
      }
      yield* assertWithinModes(view, context);
      const { task } = yield* service.runNow({ id: view.task.id }).pipe(Effect.mapError(failed));
      if (view.options.watch !== undefined && task.runCount === view.task.runCount) {
        return yield* reportSchedule(
          "Checked: no change yet",
          { task, options: view.options },
          context,
          [
            task.enabled
              ? "The watch keeps checking every minute."
              : `The watch is paused. Resume it with ${callHint("t3_schedule", { action: "resume", id: ref })}.`,
          ],
        );
      }
      return yield* reportSchedule("Ran now", { task, options: view.options }, context, [
        task.threadId === null
          ? `Next: ${callHint("t3_find_sessions", { query: task.title })} finds the session it started.`
          : `Next: ${callHint("t3_wait", { sessions: [shortRef(task.threadId)] })} to hear when the session answers.`,
      ]);
    }
  }
});

export const notifyMe = Effect.fn("agentToolkit.notifyMe")(function* (
  input: Tool.Parameters<typeof NotifyMeTool>,
) {
  const caller = yield* loadAgentCaller("t3.control");
  const { scope } = caller;
  const { context } = yield* scheduleContext(caller);
  const { nowMs } = context;
  const watched = yield* resolveSession({
    caller,
    ref: input.session,
    nowMs,
    sessions: context.visible,
  });
  const target = yield* resolveSession({
    caller,
    ref: input.to,
    nowMs,
    sessions: context.visible,
  }).pipe(
    Effect.catch((error) =>
      error._tag === "AgentToolError" && error.code === "session_required"
        ? Effect.fail(
            fail(
              "session_required",
              "Pass to: the session to send the note into. Outside a T3 session, t3_wait waits for a change instead.",
            ),
          )
        : Effect.fail(error),
    ),
  );
  const watchedRef = shortRef(watched.id);
  if (watched.id === target.id) {
    return yield* fail(
      "same_session",
      "A session cannot watch itself. Use t3_schedule to send yourself a prompt later.",
    );
  }
  if (target.archivedAt !== null) {
    return yield* fail(
      "session_archived",
      `Session ${shortRef(target.id)} is archived, so it cannot take the note.`,
    );
  }
  yield* assertTargetWithinLimits(caller.limits, target);
  const until = input.until === undefined || input.until.length === 0 ? WATCH_CHANGES : input.until;
  // A question or approval that is open now needs no watch.
  const now = watchedChange(watched, { until: ["needs-human"] }, nowMs);
  if (until.includes("needs-human") && now !== null && now.change === "needs-human") {
    return result(
      [
        `## \`${watchedRef}\` ${oneLine(watched.title, 80)} already ${now.what}`,
        "No watch was made: it waits now.",
        `Next: ${callHint("t3_session_brief", { session: watchedRef })}, then ${callHint("t3_answer", { session: watchedRef })}.`,
      ].join("\n"),
      { watching: false, sessionId: watched.id, ref: watchedRef, now: now.what },
    );
  }
  yield* sqlClient;
  const commandId =
    input.clientRequestId === undefined
      ? undefined
      : yield* commandIdFor(scope, "notify", `${watched.id}>${target.id}`, input.clientRequestId);
  const { task, options } = yield* saveNewSchedule(
    {
      title: `Watch ${watchedRef} ${oneLine(watched.title, 60)}`,
      prompt: input.note?.trim() || "Check it, then carry on with your work.",
      enabled: true,
      schedule: { type: "interval", everyMs: 60_000 },
      projectId: target.projectId,
      threadId: target.id,
      workspaceStrategy: { type: "root" },
      modelSelection: target.modelSelection,
      runtimeMode: target.runtimeMode,
      interactionMode: target.interactionMode,
      createdBy: scope.thread === undefined ? "user" : "agent",
      creationSource: "mcp",
      ...(commandId === undefined ? {} : { commandId }),
    },
    {
      ...(scope.actorUserId === null ? {} : { ownerUserId: scope.actorUserId }),
      keepThreadModel: true,
      runOnce: true,
      watch: { threadId: watched.id, until: [...until], since: isoFromMillis(nowMs) },
    },
    undefined,
  );
  const working = isWorking(watched);
  const targetText =
    caller.caller !== undefined && target.id === caller.caller.id
      ? "your session"
      : `session \`${shortRef(target.id)}\``;
  return yield* reportSchedule(`Watching \`${watchedRef}\``, { task, options }, context, [
    `T3 checks \`${watchedRef}\` every minute and sends one note into ${targetText} when it ${watchWords(until)}; then the watch ends. It survives restarts.`,
    ...(working
      ? []
      : [
          `\`${watchedRef}\` is not working now, so the note comes after its next turn. To start one, use t3_send_message.`,
        ]),
    `Cancel: ${callHint("t3_schedule", { action: "delete", id: shortRef(task.id) })}.`,
  ]);
});

export const __testing = { findSchedule, withWhenOptions, stateOf };
