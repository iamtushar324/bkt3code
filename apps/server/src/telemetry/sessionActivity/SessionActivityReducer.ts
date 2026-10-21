/**
 * T3-CUSTOM(expbkt3): session time-in-state metrics (TEC-1631).
 *
 * A pure tracker over the orchestration V2 event log. It keeps one mutually
 * exclusive STATE per session (thread) and emits a `session.state.span` each
 * time that state changes, plus transition events (`session.created`,
 * `run.finished`, `human_request.resolved`, `subagent.finished`,
 * `plan.decided`, archive and snooze events). The live reactor
 * (`SessionActivityReactor.ts`) and the history backfill
 * (`apps/server/scripts/analytics-backfill.ts`) feed it the same events, so
 * live and historical numbers mean the same thing. Time comes only from event
 * `occurredAt`; the tracker never reads a clock or a database.
 *
 * State precedence, highest first:
 *   1. `archived`        the thread is archived (terminal until unarchived).
 *   2. `waiting_human`   a runtime request waits on a person: an approval
 *                        (`waitKind: "approval"`) or a question / MCP
 *                        elicitation (`"question"`). This wins over a running
 *                        run: a question asked mid-run is human wait time.
 *   3. `agent_running`   a run is preparing, starting or running.
 *   4. `waiting_human`   (`waitKind: "plan"`) a proposed plan from a settled
 *                        run waits for the next message. Decided by the next
 *                        run, by archiving, or by the plan's own completion.
 *   5. `waiting_workers` no run is running, but background work the agent
 *                        waits on is still active: running subagents (provider
 *                        native and delegated `delegate_task` children, from
 *                        `subagent.updated`), active non-persistent
 *                        `dynamic_tool` items, and provider roster tasks that
 *                        hold completion (`backgroundWorkHoldsCompletion`).
 *                        Plain background shell commands (dev servers) and
 *                        pull request watches do not count: they can run for
 *                        days while the agent is done.
 *   6. `queued`          a run is queued and nothing above applies.
 *   7. `idle`            nothing is pending; the session waits for the next
 *                        message. `snoozed: true` marks idle time while snoozed.
 *
 * A run in `waiting` status counts as settled: it is the short window between
 * a successful turn and its checkpoint. Provider-native subagent threads
 * (Claude Agent tool transcripts) are not sessions; their time is the parent's
 * `agent_running` or `waiting_workers` time.
 *
 * Spans are split at UTC midnight, so per-day sums are exact. A state that
 * lasts no time (several events share one millisecond) emits no span. At
 * shutdown, spans of active states close with `endReason: "server_stopped"`;
 * idle and archived spans are dropped. The next server seeds every open
 * session and opens new spans with `resumedAfterRestart: true`.
 *
 * Properties hold only ids, enums, counts, durations and timestamps. Never add
 * prompt, message, title, question or answer text, paths, branches or
 * repository names.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

export type SessionState =
  | "waiting_human"
  | "agent_running"
  | "waiting_workers"
  | "queued"
  | "idle"
  | "archived";

export type SessionWaitKind = "approval" | "question" | "plan";

export type SessionSource =
  | "ui"
  | "mcp"
  | "linear_runner"
  | "schedule"
  | "delegate"
  | "fork"
  | "mattermost"
  | "unknown";

/** What started a run, from its user message. */
export type RunTrigger =
  | "human"
  | "agent"
  | "wake"
  | "delegated_result"
  | "schedule"
  | "async_answer"
  | "restart"
  | "unknown";

export type SessionActivityPropertyValue = string | number | boolean;

export interface SessionActivityEmission {
  readonly event: string;
  readonly properties: Readonly<Record<string, SessionActivityPropertyValue>>;
  /** Environment user the event is attributed to: the owner, else the sender. */
  readonly userId?: string;
  /** ISO time the event happened. */
  readonly timestamp: string;
  /** Stable identity of this event, so a re-run does not count it twice. */
  readonly insertId: string;
}

type TimeInput = string | number | DateTime.DateTime;

/**
 * The fields the tracker reads from an orchestration V2 domain event. The live
 * `OrchestrationV2DomainEvent` and a row decoded from `orchestration_events`
 * both fit.
 */
export interface SessionActivityEvent {
  readonly type: string;
  readonly threadId: string;
  readonly occurredAt: TimeInput;
  readonly runId?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly driver?: string | undefined;
  readonly payload: unknown;
}

export interface SessionActivityTrackerOptions {
  /** Set on every event; true for the history backfill. */
  readonly backfill: boolean;
}

/** Every property key the tracker can emit, for the analytics allowlist. */
export const SESSION_ACTIVITY_PROPERTY_KEYS = [
  "threadId",
  "projectId",
  "parentThreadId",
  "isChildSession",
  "state",
  "waitKind",
  "durationMs",
  "startedAt",
  "endedAt",
  "endReason",
  "spanStartedAt",
  "segmentIndex",
  "runId",
  "runOrdinal",
  "runTrigger",
  "provider",
  "providerInstanceId",
  "model",
  "effort",
  "interactionMode",
  "runtimeMode",
  "activeWorkers",
  "maxActiveWorkers",
  "backgroundTasks",
  "ownerUserId",
  "senderUserId",
  "sessionSource",
  "creationSource",
  "createdBy",
  "resumedAfterRestart",
  "backfill",
  "snoozed",
  "ageMs",
  "status",
  "queueWaitMs",
  "runDurationMs",
  "workDurationMs",
  "attempts",
  "failureClass",
  "requestKind",
  "waitMs",
  "resolution",
  "answeredByUserId",
  "subagentId",
  "driver",
  "origin",
  "childThreadPresent",
  "decision",
  "scope",
  "count",
  "runningRuns",
  "queuedRuns",
  "waitingHuman",
  "waitingWorkers",
  "activeSubagents",
] as const;

// Payloads arrive decoded (live) or as parsed JSON (backfill), so every read
// is defensive and typed `unknown` until checked.

type Rec = Readonly<Record<string, unknown>>;

function asRec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(record: Rec | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Epoch milliseconds of an ISO string, epoch number or Effect DateTime. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" || DateTime.isDateTime(value)) {
    return Option.match(DateTime.make(value), {
      onNone: () => undefined,
      onSome: DateTime.toEpochMillis,
    });
  }
  return undefined;
}

function isoOf(ms: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(ms));
}

const DAY_MS = 86_400_000;

const ACTIVE_RUN_STATUSES = new Set(["preparing", "starting", "running"]);
const FINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);
const ACTIVE_WORK_STATUSES = new Set(["pending", "running", "waiting"]);
const FINAL_SUBAGENT_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
/** Request kinds a client tool answers, not a person. */
const NON_HUMAN_REQUEST_KINDS = new Set(["dynamic_tool_call"]);

function modelInfo(selection: unknown): {
  readonly instanceId?: string;
  readonly model?: string;
  readonly effort?: string;
} {
  const record = asRec(selection);
  if (record === undefined) return {};
  let effort: string | undefined;
  const options = record.options;
  if (Array.isArray(options)) {
    for (const option of options) {
      const entry = asRec(option);
      if (entry?.id === "effort" && typeof entry.value === "string") effort = entry.value;
    }
  } else {
    const value = asRec(options)?.effort;
    if (typeof value === "string") effort = value;
  }
  const instanceId = str(record, "instanceId");
  const model = str(record, "model");
  return {
    ...(instanceId === undefined ? {} : { instanceId }),
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  };
}

function isProviderNativeSubagentThread(payload: Rec | undefined): boolean {
  return (
    asRec(payload?.lineage)?.relationshipToParent === "subagent" &&
    payload?.creationSource === "provider"
  );
}

function hasLinearLink(payload: Rec): boolean {
  if (str(payload, "linearIssueUrl") !== undefined) return true;
  return Array.isArray(payload.linearLinks) && payload.linearLinks.length > 0;
}

/**
 * Best-effort origin of a session, from its first thread payload:
 * fork lineage, delegate_task child, Mattermost-bound, Linear-tagged and
 * created by a server or MCP client (the Linear runner), web or mobile UI,
 * MCP, or a server-created session with a parent (another agent's
 * t3_create_session). A scheduled first message upgrades it to `schedule`.
 */
function sessionSourceOf(payload: Rec): SessionSource {
  const relationship = asRec(payload.lineage)?.relationshipToParent;
  if (relationship === "fork") return "fork";
  if (relationship === "subagent") return "delegate";
  if (payload.forkedFrom !== null && payload.forkedFrom !== undefined) return "fork";
  if (str(payload, "mattermostThreadUrl") !== undefined) return "mattermost";
  const creationSource = str(payload, "creationSource");
  if (hasLinearLink(payload) && (creationSource === "server" || creationSource === "mcp")) {
    return "linear_runner";
  }
  if (creationSource === "web" || creationSource === "mobile") return "ui";
  if (creationSource === "mcp") return "mcp";
  if (creationSource === "server" && str(payload, "parentThreadId") !== undefined) return "mcp";
  return "unknown";
}

function runTriggerOf(message: Rec): RunTrigger {
  if (message.delegatedCompletion !== undefined && message.delegatedCompletion !== null) {
    return "delegated_result";
  }
  if (message.notification !== undefined && message.notification !== null) return "wake";
  if (str(message, "scheduledTaskId") !== undefined) return "schedule";
  if (str(message, "id")?.startsWith("async-answer:") === true) return "async_answer";
  if (str(message, "senderThreadId") !== undefined) return "agent";
  const createdBy = str(message, "createdBy");
  if (createdBy === "agent") return "agent";
  if (createdBy === "user") return "human";
  return "unknown";
}

function waitKindOfRequest(kind: string): SessionWaitKind {
  return kind === "user_input" || kind === "mcp-elicitation" ? "question" : "approval";
}

function resolutionOf(status: string, kind: string, decision: string | undefined): string {
  if (status === "expired") return "expired";
  if (status === "cancelled") return "cancelled";
  if (kind === "user_input" || kind === "mcp-elicitation") return "answered";
  switch (decision) {
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return "approved";
    case "decline":
      return "declined";
    case "cancel":
      return "cancelled";
    default:
      return "resolved";
  }
}

/** Provider roster tasks the agent waits on; plain commands do not hold it. */
function holdingRosterTaskCount(tasks: unknown): number {
  if (!Array.isArray(tasks)) return 0;
  let count = 0;
  for (const task of tasks) {
    const entry = asRec(task);
    if (entry === undefined) continue;
    if (entry.kind !== "command" || entry.wakesAgent === true) count += 1;
  }
  return count;
}

interface RunInfo {
  readonly id: string;
  ordinal?: number;
  status: string;
  requestedAtMs?: number;
  startedAtMs?: number;
  completedAtMs?: number;
  workStartedAtMs?: number;
  userMessageId?: string;
  providerInstanceId?: string;
  model?: string;
  effort?: string;
  attempts: number;
  failureClass?: string;
  senderUserId?: string;
  trigger?: RunTrigger;
  restartContinuation: boolean;
  finished: boolean;
  /** An imported run finished later than the event that created it: finish it then. */
  deferredFinal?: { readonly status: string; readonly atMs: number };
}

interface RequestInfo {
  readonly kind: string;
  readonly waitKind: SessionWaitKind;
  readonly createdAtMs: number;
  readonly runId?: string;
  readonly live: boolean;
}

interface PlanInfo {
  readonly runId?: string;
  readonly atMs: number;
  waitingSinceMs?: number;
}

interface SubagentInfo {
  readonly startedAtMs: number;
}

interface MessageInfo {
  readonly senderUserId?: string;
  readonly trigger: RunTrigger;
}

interface OpenSpan {
  readonly key: string;
  readonly state: SessionState;
  readonly waitKind?: SessionWaitKind;
  readonly snoozed: boolean;
  readonly run?: RunInfo;
  readonly startMs: number;
  readonly resumed: boolean;
  maxWorkers: number;
}

interface ThreadTrack {
  readonly threadId: string;
  known: boolean;
  projectId?: string;
  parentThreadId?: string;
  ownerUserId?: string;
  createdAtMs?: number;
  creationSource?: string;
  createdBy?: string;
  sessionSource: SessionSource;
  providerInstanceId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  interactionMode?: string;
  runtimeMode?: string;
  activeProviderThreadId?: string;
  archived: boolean;
  snoozed: boolean;
  readonly runs: Map<string, RunInfo>;
  lastRun?: RunInfo;
  readonly requests: Map<string, RequestInfo>;
  readonly plans: Map<string, PlanInfo>;
  readonly decidedPlans: Set<string>;
  readonly subagents: Map<string, SubagentInfo>;
  readonly finishedSubagents: Set<string>;
  /** Runs already reported; later metadata-only updates of them are ignored. */
  readonly finishedRuns: Set<string>;
  readonly backgroundTools: Set<string>;
  readonly rosterTasks: Map<string, number>;
  /** Workers a restart seed counted without ids; cleared by the next worker event. */
  seededWorkers: number;
  readonly messages: Map<string, MessageInfo>;
  lastSenderUserId?: string;
  span?: OpenSpan;
  resumeNextSpan: boolean;
}

const MAX_TRACKED_MESSAGES = 64;
const MAX_FINISHED_IDS = 512;

function newThread(threadId: string): ThreadTrack {
  return {
    threadId,
    known: false,
    sessionSource: "unknown",
    archived: false,
    snoozed: false,
    runs: new Map(),
    requests: new Map(),
    plans: new Map(),
    decidedPlans: new Set(),
    subagents: new Map(),
    finishedSubagents: new Set(),
    finishedRuns: new Set(),
    backgroundTools: new Set(),
    rosterTasks: new Map(),
    seededWorkers: 0,
    messages: new Map(),
    resumeNextSpan: false,
  };
}

function rememberBounded(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size > MAX_FINISHED_IDS) {
    const oldest = set.values().next();
    if (!oldest.done) set.delete(oldest.value);
  }
}

/** Event types that may introduce a session the tracker has not seen yet. */
function introducesSession(type: string): boolean {
  return (
    type.startsWith("thread.") ||
    type === "run.created" ||
    type === "run.updated" ||
    type === "runtime-request.updated" ||
    type === "message.updated" ||
    type === "plan.updated"
  );
}

/** The current-state picture used by the reactor's periodic snapshot. */
interface StateCounts {
  readonly byOwnerState: Map<string, { ownerUserId?: string; state: SessionState; count: number }>;
  runningRuns: number;
  queuedRuns: number;
  waitingHuman: number;
  waitingWorkers: number;
  activeSubagents: number;
}

export interface SessionActivityTracker {
  /** Feed one event, in order. Returns the analytics events it produced. */
  readonly apply: (event: SessionActivityEvent) => ReadonlyArray<SessionActivityEmission>;
  /**
   * Seed a session from a projection shell after a restart. Emits nothing; the
   * span it opens at `nowMs` carries `resumedAfterRestart: true`.
   */
  readonly seed: (shell: unknown, nowMs: number) => void;
  /**
   * Close the open spans of active states (everything but `idle` and
   * `archived`), for example with `server_stopped` on shutdown. Idle and
   * archived time is cheap to lose and is resumed by the next boot's seed, so
   * shutdown records only the few spans that matter within its time budget.
   */
  readonly closeActive: (
    nowMs: number,
    endReason: string,
  ) => ReadonlyArray<SessionActivityEmission>;
  /** Point-in-time counts: one event per (owner, state), plus one totals event. */
  readonly snapshot: (nowMs: number) => ReadonlyArray<SessionActivityEmission>;
}

export function makeSessionActivityTracker(
  options: SessionActivityTrackerOptions,
): SessionActivityTracker {
  const threads = new Map<string, ThreadTrack>();
  /** Threads that are not sessions (provider-native subagent transcripts, deleted). */
  const ignored = new Set<string>();

  const emission = (
    t: ThreadTrack | undefined,
    event: string,
    atMs: number,
    insertId: string,
    properties: Record<string, SessionActivityPropertyValue | undefined>,
    userId?: string,
  ): SessionActivityEmission => {
    const clean: Record<string, SessionActivityPropertyValue> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value !== undefined) clean[key] = value;
    }
    clean.backfill = options.backfill;
    const attributed = userId ?? t?.ownerUserId ?? t?.lastSenderUserId;
    return {
      event,
      properties: clean,
      ...(attributed === undefined ? {} : { userId: attributed }),
      timestamp: isoOf(atMs),
      insertId,
    };
  };

  const updateThreadFields = (t: ThreadTrack, payload: Rec, atMs: number) => {
    const firstPayload = !t.known;
    t.known = true;
    const projectId = str(payload, "projectId");
    if (projectId !== undefined) t.projectId = projectId;
    const parentThreadId =
      str(payload, "parentThreadId") ?? str(asRec(payload.lineage), "parentThreadId");
    if (parentThreadId !== undefined) t.parentThreadId = parentThreadId;
    const ownerUserId = str(payload, "ownerUserId");
    if (ownerUserId !== undefined) t.ownerUserId = ownerUserId;
    t.createdAtMs ??= toEpochMs(payload.createdAt) ?? atMs;
    const creationSource = str(payload, "creationSource");
    if (creationSource !== undefined) t.creationSource = creationSource;
    const createdBy = str(payload, "createdBy");
    if (createdBy !== undefined) t.createdBy = createdBy;
    if (firstPayload) t.sessionSource = sessionSourceOf(payload);
    const providerInstanceId = str(payload, "providerInstanceId");
    if (providerInstanceId !== undefined) t.providerInstanceId = providerInstanceId;
    const selection = modelInfo(payload.modelSelection);
    if (selection.model !== undefined) t.model = selection.model;
    if (payload.modelSelection !== undefined) {
      if (selection.effort === undefined) delete t.effort;
      else t.effort = selection.effort;
    }
    const interactionMode = str(payload, "interactionMode");
    if (interactionMode !== undefined) t.interactionMode = interactionMode;
    const runtimeMode = str(payload, "runtimeMode");
    if (runtimeMode !== undefined) t.runtimeMode = runtimeMode;
    if ("activeProviderThreadId" in payload) {
      const active = str(payload, "activeProviderThreadId");
      if (active === undefined) delete t.activeProviderThreadId;
      else t.activeProviderThreadId = active;
    }
    if ("archivedAt" in payload) t.archived = toEpochMs(payload.archivedAt) !== undefined;
    if ("snoozedUntil" in payload) t.snoozed = toEpochMs(payload.snoozedUntil) !== undefined;
  };

  const baseProps = (t: ThreadTrack) => ({
    threadId: t.threadId,
    projectId: t.projectId,
    parentThreadId: t.parentThreadId,
    isChildSession: t.parentThreadId !== undefined,
    ownerUserId: t.ownerUserId,
    sessionSource: t.sessionSource,
  });

  const activeWorkers = (t: ThreadTrack) => t.subagents.size + t.seededWorkers;

  const rosterCount = (t: ThreadTrack) => {
    if (t.activeProviderThreadId !== undefined) {
      return t.rosterTasks.get(t.activeProviderThreadId) ?? 0;
    }
    let total = 0;
    for (const count of t.rosterTasks.values()) total += count;
    return total;
  };

  const runById = (t: ThreadTrack, runId: string | undefined): RunInfo | undefined => {
    if (runId === undefined) return undefined;
    return t.runs.get(runId) ?? (t.lastRun?.id === runId ? t.lastRun : undefined);
  };

  const derive = (
    t: ThreadTrack,
  ): { state: SessionState; waitKind?: SessionWaitKind; run?: RunInfo } => {
    if (t.archived) return { state: "archived" };
    if (t.requests.size > 0) {
      let latest: RequestInfo | undefined;
      for (const request of t.requests.values()) {
        if (latest === undefined || request.createdAtMs >= latest.createdAtMs) latest = request;
      }
      const run = runById(t, latest?.runId);
      return {
        state: "waiting_human",
        waitKind: latest?.waitKind ?? "approval",
        ...(run === undefined ? {} : { run }),
      };
    }
    let active: RunInfo | undefined;
    let queued: RunInfo | undefined;
    for (const run of t.runs.values()) {
      if (ACTIVE_RUN_STATUSES.has(run.status)) {
        if (active === undefined || (run.ordinal ?? 0) > (active.ordinal ?? 0)) active = run;
      } else if (run.status === "queued") {
        if (queued === undefined || (run.ordinal ?? 0) < (queued.ordinal ?? 0)) queued = run;
      }
    }
    if (active !== undefined) return { state: "agent_running", run: active };
    if (t.plans.size > 0) {
      let latestPlan: PlanInfo | undefined;
      for (const plan of t.plans.values()) {
        if (latestPlan === undefined || plan.atMs >= latestPlan.atMs) latestPlan = plan;
      }
      const run = runById(t, latestPlan?.runId);
      return { state: "waiting_human", waitKind: "plan", ...(run === undefined ? {} : { run }) };
    }
    if (activeWorkers(t) > 0 || t.backgroundTools.size > 0 || rosterCount(t) > 0) {
      return { state: "waiting_workers", ...(t.lastRun === undefined ? {} : { run: t.lastRun }) };
    }
    if (queued !== undefined) return { state: "queued", run: queued };
    return { state: "idle" };
  };

  const spanEmissions = (
    t: ThreadTrack,
    span: OpenSpan,
    endMs: number,
    endReason: string,
  ): ReadonlyArray<SessionActivityEmission> => {
    // Several events can share one millisecond. A state that lasted no time is
    // not a span, and emitting it would also reuse the next span's insert id.
    if (endMs <= span.startMs) return [];
    const end = endMs;
    const run = span.run;
    const common = {
      ...baseProps(t),
      state: span.state,
      waitKind: span.waitKind,
      endReason,
      spanStartedAt: isoOf(span.startMs),
      runId: run?.id,
      runOrdinal: run?.ordinal,
      runTrigger: run?.trigger,
      provider: t.provider,
      providerInstanceId: run?.providerInstanceId ?? t.providerInstanceId,
      model: run?.model ?? t.model,
      effort: run?.effort ?? t.effort,
      interactionMode: t.interactionMode,
      runtimeMode: t.runtimeMode,
      activeWorkers: activeWorkers(t),
      maxActiveWorkers: Math.max(span.maxWorkers, activeWorkers(t)),
      backgroundTasks: t.backgroundTools.size + rosterCount(t),
      senderUserId: run?.senderUserId ?? t.lastSenderUserId,
      creationSource: t.creationSource,
      resumedAfterRestart: span.resumed,
      snoozed: span.state === "idle" ? span.snoozed : undefined,
    };
    const out: Array<SessionActivityEmission> = [];
    let segmentStart = span.startMs;
    let segmentIndex = 0;
    do {
      const nextMidnight = (Math.floor(segmentStart / DAY_MS) + 1) * DAY_MS;
      const segmentEnd = Math.min(end, nextMidnight);
      const last = segmentEnd >= end;
      out.push(
        emission(
          t,
          "session.state.span",
          segmentEnd,
          [
            "session.state.span",
            t.threadId,
            span.state,
            span.waitKind ?? "",
            run?.id ?? "",
            segmentStart,
          ].join("|"),
          {
            ...common,
            durationMs: segmentEnd - segmentStart,
            startedAt: isoOf(segmentStart),
            endedAt: isoOf(segmentEnd),
            segmentIndex,
            // A segment cut at midnight continues in the same state.
            endReason: last ? endReason : span.state,
          },
        ),
      );
      segmentStart = segmentEnd;
      segmentIndex += 1;
    } while (segmentStart < end);
    return out;
  };

  /** Recompute the state; close the open span and open a new one when it changed. */
  const reconcile = (t: ThreadTrack, atMs: number, out: Array<SessionActivityEmission>) => {
    const next = derive(t);
    if (next.state === "waiting_human" && next.waitKind === "plan") {
      for (const plan of t.plans.values()) plan.waitingSinceMs ??= atMs;
    }
    const snoozed = next.state === "idle" && t.snoozed;
    const key = `${next.state}|${next.waitKind ?? ""}|${snoozed}|${next.run?.id ?? ""}`;
    const workers = activeWorkers(t);
    if (t.span !== undefined && t.span.key === key) {
      t.span.maxWorkers = Math.max(t.span.maxWorkers, workers);
      return;
    }
    const previous = t.span;
    if (previous !== undefined) out.push(...spanEmissions(t, previous, atMs, next.state));
    // A replaced zero-length span hands on its restart flag.
    const carriesResume = previous !== undefined && previous.startMs >= atMs && previous.resumed;
    t.span = {
      key,
      state: next.state,
      ...(next.waitKind === undefined ? {} : { waitKind: next.waitKind }),
      snoozed,
      ...(next.run === undefined ? {} : { run: next.run }),
      startMs: atMs,
      resumed: t.resumeNextSpan || carriesResume,
      maxWorkers: workers,
    };
    t.resumeNextSpan = false;
  };

  const decidePlan = (
    t: ThreadTrack,
    planId: string,
    plan: PlanInfo,
    atMs: number,
    decision: string,
    out: Array<SessionActivityEmission>,
  ) => {
    t.plans.delete(planId);
    rememberBounded(t.decidedPlans, planId);
    out.push(
      emission(t, "plan.decided", atMs, `plan.decided|${t.threadId}|${planId}`, {
        ...baseProps(t),
        runId: plan.runId,
        decision,
        // Zero when the plan was decided before its run settled.
        waitMs: plan.waitingSinceMs === undefined ? 0 : Math.max(0, atMs - plan.waitingSinceMs),
      }),
    );
  };

  const decidePlans = (
    t: ThreadTrack,
    atMs: number,
    decisionFor: (planId: string) => string,
    out: Array<SessionActivityEmission>,
  ) => {
    for (const [planId, plan] of [...t.plans]) {
      decidePlan(t, planId, plan, atMs, decisionFor(planId), out);
    }
  };

  const closeRequest = (
    t: ThreadTrack,
    requestId: string,
    request: RequestInfo,
    atMs: number,
    resolution: string,
    resolvedAtMs: number,
    answeredByUserId: string | undefined,
    out: Array<SessionActivityEmission>,
  ) => {
    t.requests.delete(requestId);
    out.push(
      emission(
        t,
        "human_request.resolved",
        atMs,
        `human_request.resolved|${t.threadId}|${requestId}`,
        {
          ...baseProps(t),
          runId: request.runId,
          requestKind: request.kind,
          waitKind: request.waitKind,
          waitMs: Math.max(0, resolvedAtMs - request.createdAtMs),
          resolution,
          answeredByUserId,
        },
      ),
    );
  };

  const finishRun = (
    t: ThreadTrack,
    run: RunInfo,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    run.finished = true;
    rememberBounded(t.finishedRuns, run.id);
    t.runs.delete(run.id);
    t.lastRun = run;
    const completedAtMs = run.completedAtMs ?? atMs;
    out.push(
      emission(t, "run.finished", completedAtMs, `run.finished|${t.threadId}|${run.id}`, {
        ...baseProps(t),
        runId: run.id,
        runOrdinal: run.ordinal,
        runTrigger: run.trigger,
        status: run.status,
        queueWaitMs:
          run.startedAtMs !== undefined && run.requestedAtMs !== undefined
            ? Math.max(0, run.startedAtMs - run.requestedAtMs)
            : undefined,
        runDurationMs:
          run.startedAtMs !== undefined ? Math.max(0, completedAtMs - run.startedAtMs) : undefined,
        workDurationMs:
          run.workStartedAtMs !== undefined
            ? Math.max(0, completedAtMs - run.workStartedAtMs)
            : undefined,
        attempts: run.attempts,
        provider: t.provider,
        providerInstanceId: run.providerInstanceId ?? t.providerInstanceId,
        model: run.model ?? t.model,
        effort: run.effort ?? t.effort,
        interactionMode: t.interactionMode,
        runtimeMode: t.runtimeMode,
        senderUserId: run.senderUserId,
        failureClass: run.status === "failed" ? (run.failureClass ?? "unknown") : undefined,
      }),
    );
    // A live request cannot be answered once its run has ended.
    for (const [requestId, request] of t.requests) {
      if (request.live && request.runId === run.id) {
        closeRequest(t, requestId, request, atMs, "abandoned", atMs, undefined, out);
      }
    }
  };

  const applyRun = (
    t: ThreadTrack,
    event: SessionActivityEvent,
    payload: Rec,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    const id = str(payload, "id");
    if (id === undefined) return;
    // A finished run keeps receiving updates (delivery acknowledgements and
    // the like). Re-reading one would report it twice, and as an imported run.
    if (t.finishedRuns.has(id)) return;
    let run = t.runs.get(id);
    const firstSeen = run === undefined;
    if (run === undefined) {
      run = { id, status: "queued", attempts: 0, restartContinuation: false, finished: false };
      t.runs.set(id, run);
    }
    const status = str(payload, "status");
    if (status !== undefined) run.status = status;
    if (typeof payload.ordinal === "number") run.ordinal = payload.ordinal;
    const requestedAtMs = toEpochMs(payload.requestedAt);
    if (requestedAtMs !== undefined) run.requestedAtMs = requestedAtMs;
    const startedAtMs = toEpochMs(payload.startedAt);
    if (startedAtMs !== undefined) run.startedAtMs = startedAtMs;
    const completedAtMs = toEpochMs(payload.completedAt);
    if (completedAtMs !== undefined) run.completedAtMs = completedAtMs;
    const workStartedAtMs = toEpochMs(payload.workStartedAt);
    if (workStartedAtMs !== undefined) run.workStartedAtMs = workStartedAtMs;
    const providerInstanceId = str(payload, "providerInstanceId");
    if (providerInstanceId !== undefined) run.providerInstanceId = providerInstanceId;
    const selection = modelInfo(payload.modelSelection);
    if (selection.model !== undefined) run.model = selection.model;
    if (selection.effort !== undefined) run.effort = selection.effort;
    if (str(payload, "restartContinuationOfRunId") !== undefined) run.restartContinuation = true;
    const userMessageId = str(payload, "userMessageId");
    if (userMessageId !== undefined && run.userMessageId === undefined) {
      run.userMessageId = userMessageId;
      const message = t.messages.get(userMessageId);
      if (message !== undefined) {
        t.messages.delete(userMessageId);
        if (message.senderUserId !== undefined) run.senderUserId = message.senderUserId;
        run.trigger = message.trigger;
      }
    }
    if (run.restartContinuation) run.trigger = "restart";
    if (event.driver !== undefined) t.provider = event.driver;

    if (event.type === "run.created") {
      t.seededWorkers = 0;
      if (t.plans.size > 0) {
        const sourcePlanId = str(asRec(payload.sourcePlanRef), "planId");
        decidePlans(
          t,
          atMs,
          (planId) => (planId === sourcePlanId ? "implemented" : "follow_up"),
          out,
        );
      }
      // A newer run means an older run's live requests are orphaned.
      for (const [requestId, request] of t.requests) {
        if (request.live && request.runId !== undefined && request.runId !== id) {
          const owner = runById(t, request.runId);
          if (owner === undefined || owner.finished) {
            closeRequest(t, requestId, request, atMs, "abandoned", atMs, undefined, out);
          }
        }
      }
    }
    // Imported history writes a run once, already finished, at its completion
    // time. Replay its running time from the recorded start instead.
    if (firstSeen && FINAL_RUN_STATUSES.has(run.status) && run.startedAtMs !== undefined) {
      const finalStatus = run.status;
      run.status = "running";
      const runningFromMs = Math.max(run.startedAtMs, t.span?.startMs ?? run.startedAtMs);
      if (runningFromMs < atMs) reconcile(t, runningFromMs, out);
      if (run.completedAtMs !== undefined && run.completedAtMs > atMs) {
        run.deferredFinal = { status: finalStatus, atMs: run.completedAtMs };
        return;
      }
      run.status = finalStatus;
    }
    if (FINAL_RUN_STATUSES.has(run.status)) {
      delete run.deferredFinal;
      finishRun(t, run, atMs, out);
    }
  };

  /** Finishes imported runs whose recorded completion time has passed. */
  const settleDeferredRuns = (
    t: ThreadTrack,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    const due = [...t.runs.values()]
      .filter((run) => run.deferredFinal !== undefined && run.deferredFinal.atMs <= atMs)
      .sort((a, b) => (a.deferredFinal?.atMs ?? 0) - (b.deferredFinal?.atMs ?? 0));
    for (const run of due) {
      const final = run.deferredFinal;
      if (final === undefined) continue;
      delete run.deferredFinal;
      run.status = final.status;
      finishRun(t, run, final.atMs, out);
      reconcile(t, final.atMs, out);
    }
  };

  const applyRequest = (
    t: ThreadTrack,
    event: SessionActivityEvent,
    payload: Rec,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    const id = str(payload, "id");
    const kind = str(payload, "kind");
    const status = str(payload, "status");
    if (id === undefined || kind === undefined || status === undefined) return;
    if (NON_HUMAN_REQUEST_KINDS.has(kind)) return;
    if (status === "pending") {
      if (!t.requests.has(id)) {
        t.requests.set(id, {
          kind,
          waitKind: waitKindOfRequest(kind),
          createdAtMs: toEpochMs(payload.createdAt) ?? atMs,
          ...(event.runId === undefined ? {} : { runId: event.runId }),
          live: asRec(payload.responseCapability)?.type === "live",
        });
      }
      return;
    }
    const request = t.requests.get(id);
    if (request === undefined) return;
    closeRequest(
      t,
      id,
      request,
      atMs,
      resolutionOf(status, kind, str(payload, "decision")),
      toEpochMs(payload.resolvedAt) ?? atMs,
      status === "resolved" ? event.actorUserId : undefined,
      out,
    );
  };

  const applySubagent = (
    t: ThreadTrack,
    event: SessionActivityEvent,
    payload: Rec,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    const id = str(payload, "id");
    const status = str(payload, "status");
    if (id === undefined || status === undefined) return;
    t.seededWorkers = 0;
    if (ACTIVE_WORK_STATUSES.has(status)) {
      if (!t.subagents.has(id) && !t.finishedSubagents.has(id)) {
        t.subagents.set(id, { startedAtMs: toEpochMs(payload.startedAt) ?? atMs });
      }
      return;
    }
    const info = t.subagents.get(id);
    t.subagents.delete(id);
    if (!FINAL_SUBAGENT_STATUSES.has(status) || t.finishedSubagents.has(id)) return;
    rememberBounded(t.finishedSubagents, id);
    const startedAtMs = toEpochMs(payload.startedAt) ?? info?.startedAtMs;
    const completedAtMs = toEpochMs(payload.completedAt) ?? atMs;
    out.push(
      emission(t, "subagent.finished", completedAtMs, `subagent.finished|${t.threadId}|${id}`, {
        ...baseProps(t),
        runId: str(payload, "runId") ?? event.runId,
        subagentId: id,
        status,
        origin: str(payload, "origin"),
        driver: str(payload, "driver"),
        durationMs:
          startedAtMs === undefined ? undefined : Math.max(0, completedAtMs - startedAtMs),
        childThreadPresent: str(payload, "childThreadId") !== undefined,
      }),
    );
  };

  const applyTurnItem = (t: ThreadTrack, event: SessionActivityEvent, payload: Rec) => {
    const type = payload.type;
    if (type === "dynamic_tool") {
      const id = str(payload, "id");
      if (id === undefined) return;
      const persistent = asRec(payload.input)?.persistent === true;
      const status = str(payload, "status");
      if (!persistent && status !== undefined && ACTIVE_WORK_STATUSES.has(status)) {
        t.backgroundTools.add(id);
      } else {
        t.backgroundTools.delete(id);
      }
      return;
    }
    if (type === "error") {
      const failureClass = str(asRec(payload.failure), "class");
      const run = runById(t, str(payload, "runId") ?? event.runId);
      if (failureClass !== undefined && run !== undefined) run.failureClass = failureClass;
    }
  };

  const applyPlan = (
    t: ThreadTrack,
    payload: Rec,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    if (payload.kind !== "proposed_plan") return;
    const id = str(payload, "id");
    const status = str(payload, "status");
    if (id === undefined || status === undefined) return;
    if (status === "draft" || status === "active") {
      if (!t.decidedPlans.has(id) && !t.plans.has(id)) {
        const runId = str(payload, "runId");
        t.plans.set(id, { atMs, ...(runId === undefined ? {} : { runId }) });
      }
      return;
    }
    // completed or superseded
    const plan = t.plans.get(id);
    if (plan !== undefined) decidePlan(t, id, plan, atMs, status, out);
  };

  const applyMessage = (t: ThreadTrack, payload: Rec) => {
    if (payload.role !== "user") return;
    const id = str(payload, "id");
    if (id === undefined) return;
    const senderUserId = str(payload, "sentByUserId");
    const trigger = runTriggerOf(payload);
    if (trigger === "schedule" && t.sessionSource === "unknown") t.sessionSource = "schedule";
    if (senderUserId !== undefined && trigger === "human") t.lastSenderUserId = senderUserId;
    // The run may have been created before its message reached the log.
    for (const run of t.runs.values()) {
      if (run.userMessageId === id && run.trigger === undefined) {
        if (senderUserId !== undefined) run.senderUserId = senderUserId;
        run.trigger = run.restartContinuation ? "restart" : trigger;
        return;
      }
    }
    t.messages.set(id, { trigger, ...(senderUserId === undefined ? {} : { senderUserId }) });
    if (t.messages.size > MAX_TRACKED_MESSAGES) {
      const oldest = t.messages.keys().next();
      if (!oldest.done) t.messages.delete(oldest.value);
    }
  };

  const applyThreadEvent = (
    t: ThreadTrack,
    event: SessionActivityEvent,
    payload: Rec | undefined,
    atMs: number,
    out: Array<SessionActivityEmission>,
  ) => {
    const wasKnown = t.known;
    const wasArchived = t.archived;
    const wasSnoozed = t.snoozed;
    if (payload !== undefined) updateThreadFields(t, payload, atMs);
    if (event.driver !== undefined) t.provider = event.driver;
    const ageMs = t.createdAtMs === undefined ? undefined : Math.max(0, atMs - t.createdAtMs);
    const lifecycle = (name: string) =>
      out.push(
        emission(t, name, atMs, `${name}|${t.threadId}|${atMs}`, { ...baseProps(t), ageMs }),
      );
    switch (event.type) {
      case "thread.created":
        if (!wasKnown) {
          out.push(
            emission(t, "session.created", atMs, `session.created|${t.threadId}`, {
              ...baseProps(t),
              provider: t.provider,
              providerInstanceId: t.providerInstanceId,
              model: t.model,
              effort: t.effort,
              interactionMode: t.interactionMode,
              runtimeMode: t.runtimeMode,
              creationSource: t.creationSource,
              createdBy: t.createdBy,
            }),
          );
        }
        return;
      case "thread.archived":
        t.archived = true;
        if (!wasArchived) {
          lifecycle("session.archived");
          if (t.plans.size > 0) decidePlans(t, atMs, () => "archived", out);
        }
        return;
      case "thread.unarchived":
        t.archived = false;
        if (wasArchived) lifecycle("session.unarchived");
        return;
      case "thread.snoozed":
        t.snoozed = true;
        if (!wasSnoozed) lifecycle("session.snoozed");
        return;
      case "thread.unsnoozed":
        t.snoozed = false;
        if (wasSnoozed) lifecycle("session.unsnoozed");
        return;
      default:
        return;
    }
  };

  const apply: SessionActivityTracker["apply"] = (event) => {
    if (ignored.has(event.threadId)) return [];
    const atMs = toEpochMs(event.occurredAt);
    if (atMs === undefined) return [];
    const payload = asRec(event.payload);
    let t = threads.get(event.threadId);
    if (t === undefined) {
      if (!introducesSession(event.type)) return [];
      if (event.type.startsWith("thread.") && isProviderNativeSubagentThread(payload)) {
        ignored.add(event.threadId);
        return [];
      }
      t = newThread(event.threadId);
      threads.set(event.threadId, t);
    }
    const out: Array<SessionActivityEmission> = [];
    settleDeferredRuns(t, atMs, out);

    if (event.type === "thread.deleted") {
      if (t.span !== undefined) out.push(...spanEmissions(t, t.span, atMs, "deleted"));
      threads.delete(event.threadId);
      ignored.add(event.threadId);
      return out;
    }

    if (event.type.startsWith("thread.")) {
      applyThreadEvent(t, event, payload, atMs, out);
    } else if (payload !== undefined) {
      switch (event.type) {
        case "run.created":
        case "run.updated":
          applyRun(t, event, payload, atMs, out);
          break;
        case "run-attempt.created": {
          const run = runById(t, str(payload, "runId"));
          if (run !== undefined) run.attempts += 1;
          if (event.driver !== undefined) t.provider = event.driver;
          break;
        }
        case "runtime-request.updated":
          applyRequest(t, event, payload, atMs, out);
          break;
        case "subagent.updated":
          applySubagent(t, event, payload, atMs, out);
          break;
        case "turn-item.updated":
          applyTurnItem(t, event, payload);
          break;
        case "provider-thread.updated": {
          const id = str(payload, "id");
          if (id === undefined) break;
          t.seededWorkers = 0;
          const count = holdingRosterTaskCount(payload.pendingBackgroundTasks);
          if (count > 0) t.rosterTasks.set(id, count);
          else t.rosterTasks.delete(id);
          break;
        }
        case "plan.updated":
          applyPlan(t, payload, atMs, out);
          break;
        case "message.updated":
          applyMessage(t, payload);
          break;
        default:
          break;
      }
    }
    reconcile(t, atMs, out);
    return out;
  };

  const seed: SessionActivityTracker["seed"] = (shell, nowMs) => {
    const payload = asRec(shell);
    const threadId = str(payload, "id");
    if (payload === undefined || threadId === undefined) return;
    if (isProviderNativeSubagentThread(payload) || toEpochMs(payload.deletedAt) !== undefined) {
      ignored.add(threadId);
      return;
    }
    const t = newThread(threadId);
    threads.set(threadId, t);
    updateThreadFields(t, payload, nowMs);
    const activeRunId = str(payload, "activeRunId");
    const activityStatus = str(payload, "activityRunStatus");
    if (
      activeRunId !== undefined &&
      activityStatus !== undefined &&
      ACTIVE_RUN_STATUSES.has(activityStatus)
    ) {
      const startedAtMs = toEpochMs(payload.activityRunStartedAt);
      t.runs.set(activeRunId, {
        id: activeRunId,
        status: activityStatus,
        attempts: 0,
        restartContinuation: false,
        finished: false,
        ...(startedAtMs === undefined ? {} : { startedAtMs }),
      });
    }
    const latestRunId = str(payload, "latestRunId");
    if (latestRunId !== undefined && payload.status === "queued" && !t.runs.has(latestRunId)) {
      t.runs.set(latestRunId, {
        id: latestRunId,
        status: "queued",
        attempts: 0,
        restartContinuation: false,
        finished: false,
      });
    }
    const pending = asRec(payload.pendingRuntimeRequest);
    const requestId = str(pending, "id");
    const requestKind = str(pending, "kind");
    if (
      requestId !== undefined &&
      requestKind !== undefined &&
      !NON_HUMAN_REQUEST_KINDS.has(requestKind)
    ) {
      t.requests.set(requestId, {
        kind: requestKind,
        waitKind: waitKindOfRequest(requestKind),
        createdAtMs: toEpochMs(pending?.createdAt) ?? nowMs,
        // Live requests did not survive the restart; message-answered ones did.
        live: false,
      });
    }
    const subagentCount =
      typeof payload.activeSubagentCount === "number" ? payload.activeSubagentCount : 0;
    t.seededWorkers = subagentCount + holdingRosterTaskCount(payload.pendingBackgroundTasks);
    t.resumeNextSpan = true;
    reconcile(t, nowMs, []);
  };

  const closeActive: SessionActivityTracker["closeActive"] = (nowMs, endReason) => {
    const out: Array<SessionActivityEmission> = [];
    for (const t of threads.values()) {
      if (t.span === undefined || t.span.state === "idle" || t.span.state === "archived") {
        continue;
      }
      out.push(...spanEmissions(t, t.span, nowMs, endReason));
      delete t.span;
    }
    return out;
  };

  const snapshot: SessionActivityTracker["snapshot"] = (nowMs) => {
    const counts: StateCounts = {
      byOwnerState: new Map(),
      runningRuns: 0,
      queuedRuns: 0,
      waitingHuman: 0,
      waitingWorkers: 0,
      activeSubagents: 0,
    };
    for (const t of threads.values()) {
      const span = t.span;
      if (span === undefined || span.state === "archived") continue;
      const key = `${t.ownerUserId ?? ""}|${span.state}`;
      const entry = counts.byOwnerState.get(key);
      if (entry === undefined) {
        counts.byOwnerState.set(key, {
          ...(t.ownerUserId === undefined ? {} : { ownerUserId: t.ownerUserId }),
          state: span.state,
          count: 1,
        });
      } else {
        entry.count += 1;
      }
      if (span.state === "agent_running") counts.runningRuns += 1;
      if (span.state === "waiting_human") counts.waitingHuman += 1;
      if (span.state === "waiting_workers") counts.waitingWorkers += 1;
      for (const run of t.runs.values()) if (run.status === "queued") counts.queuedRuns += 1;
      counts.activeSubagents += activeWorkers(t);
    }
    const out: Array<SessionActivityEmission> = [];
    for (const entry of counts.byOwnerState.values()) {
      out.push(
        emission(
          undefined,
          "session.state.snapshot",
          nowMs,
          `session.state.snapshot|${entry.ownerUserId ?? ""}|${entry.state}|${nowMs}`,
          { scope: "user", ownerUserId: entry.ownerUserId, state: entry.state, count: entry.count },
          entry.ownerUserId,
        ),
      );
    }
    out.push({
      event: "session.state.snapshot",
      properties: {
        scope: "total",
        runningRuns: counts.runningRuns,
        queuedRuns: counts.queuedRuns,
        waitingHuman: counts.waitingHuman,
        waitingWorkers: counts.waitingWorkers,
        activeSubagents: counts.activeSubagents,
        backfill: options.backfill,
      },
      timestamp: isoOf(nowMs),
      insertId: `session.state.snapshot|total|${nowMs}`,
    });
    return out;
  };

  return { apply, seed, closeActive, snapshot };
}
