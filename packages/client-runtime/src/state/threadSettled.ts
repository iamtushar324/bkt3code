// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
// T3-CUSTOM(expbkt3): lifecycle helpers consume the V2 presentation shell.

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";

interface SettlementRunLike {
  readonly turnId?: unknown;
  // T3-CUSTOM(expbkt3): native runs and legacy cached turns share this policy.
  readonly runId?: unknown;
  // T3-CUSTOM(expbkt3): legacy cached turn timing remains accepted.
  readonly durationMs?: number | null;
  readonly assistantMessageId?: unknown;
  readonly status?: string;
  readonly state?: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

interface SettlementRuntimeLike {
  readonly threadId?: unknown;
  readonly providerName?: unknown;
  readonly runtimeMode?: unknown;
  readonly activeTurnId?: unknown;
  readonly lastError?: unknown;
  readonly status: string;
  readonly updatedAt?: string;
}

interface QueuedThreadShell {
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn?: SettlementRunLike | null;
  readonly latestRun?: SettlementRunLike | null;
  readonly session?: SettlementRuntimeLike | null;
  readonly runtime?: SettlementRuntimeLike | null;
}

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function hasQueuedTurnStart(
  shell: QueuedThreadShell,
  options: { readonly now: string },
): boolean {
  if (
    shell.runtime?.status === "preparing" ||
    shell.runtime?.status === "queued" ||
    shell.runtime?.status === "starting"
  ) {
    return true;
  }
  if (shell.latestUserMessageAt == null) return false;
  // T3-CUSTOM(expbkt3): failed native runs stop the queued-start grace period.
  if (
    (shell.runtime ?? shell.session)?.status === "error" ||
    (shell.runtime ?? shell.session)?.status === "failed"
  )
    return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestRun ?? shell.latestTurn ?? null;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

// T3-CUSTOM(expbkt3): compatibility policy for the fork phase sidebar.
export type ChangeRequestStateLike = "open" | "closed" | "merged";

/**
 * The slice of a change request the settle rules need. `updatedAt` is the
 * provider's last-activity timestamp; for a merged/closed request it bounds
 * when the terminal state landed.
 */
export interface ChangeRequestSettleSource {
  readonly state: ChangeRequestStateLike;
  readonly updatedAt?: string | null | undefined;
}

/** What the settle rules need to know about the thread's own timeline. */
export interface ThreadActivitySource extends QueuedThreadShell {
  readonly createdAt: string;
}

/**
 * Latest USER-initiated activity: messages and the turn requests they start,
 * deliberately not the agent-side started/completed stamps. The settle-on-
 * merge anchor uses this so a merge landing mid-turn still settles the
 * thread when that turn finishes, while a user re-engaging after the merge
 * blocks it for good. Falls back to creation time for untouched threads.
 */
function threadUserActivityAnchorAt(thread: ThreadActivitySource): string {
  const messageAt = thread.latestUserMessageAt;
  const requestedAt = (thread.latestRun ?? thread.latestTurn)?.requestedAt;
  let anchor = thread.createdAt;
  for (const candidate of [messageAt, requestedAt]) {
    if (candidate != null && Date.parse(candidate) > Date.parse(anchor)) {
      anchor = candidate;
    }
  }
  return anchor;
}

/**
 * Returns whether the change request settles the thread immediately. A
 * terminal request settles the thread only while it postdates every user-
 * initiated event in it: settling on a merge happens ONCE. A request last
 * touched before the thread was created is inherited branch history (a new
 * thread started at a worktree root whose PR already merged), and one older
 * than the user's latest engagement was already adjudicated — re-engaging a
 * thread whose PR merged is the user saying the conversation outlived the
 * PR. Unknown timestamps keep the old always-settle behavior.
 */
export function changeRequestAutoSettles(
  changeRequest: ChangeRequestSettleSource | null | undefined,
  options: {
    readonly autoSettleOnMerge?: boolean | undefined;
    readonly thread?: ThreadActivitySource | null | undefined;
  } = {},
): boolean {
  if (changeRequest == null) return false;
  const terminal =
    changeRequest.state === "closed" ||
    (changeRequest.state === "merged" && options.autoSettleOnMerge !== false);
  if (!terminal) return false;
  if (changeRequest.updatedAt == null || options.thread == null) return true;
  const updatedAtMs = Date.parse(changeRequest.updatedAt);
  const anchorAtMs = Date.parse(threadUserActivityAnchorAt(options.thread));
  // Malformed timestamps fall back to settling, matching servers that never
  // report updatedAt.
  if (Number.isNaN(updatedAtMs) || Number.isNaN(anchorAtMs)) return true;
  return updatedAtMs >= anchorAtMs;
}

// T3-CUSTOM(expbkt3): retained for the fork sidebar; upstream removed it.
export function threadLastActivityAt(shell: QueuedThreadShell): string | null {
  const candidates = [
    shell.latestUserMessageAt,
    (shell.latestRun ?? shell.latestTurn)?.requestedAt,
    (shell.latestRun ?? shell.latestTurn)?.startedAt,
    (shell.latestRun ?? shell.latestTurn)?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

// T3-CUSTOM(expbkt3): retained with the fork compatibility settle policy.
export function canSettle(
  shell: QueuedThreadShell & {
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
  },
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  const runtime = shell.runtime ?? shell.session;
  if (
    runtime?.status === "preparing" ||
    runtime?.status === "starting" ||
    runtime?.status === "running"
  )
    return false;
  // Queued work is as blocked-on-progress as a live session: settling it
  // (or auto-settling it on a closed PR) would hide a just-requested turn.
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
}

export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  if (shell.source?.pendingRuntimeRequest != null) return true;
  if (shell.pendingSubagentRequest != null) return true;
  const failedAt = failureEdgeAt(shell);
  if (
    failedAt !== undefined &&
    (shell.snoozedAt == null ||
      (failedAt != null && Date.parse(failedAt) > Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  return completionWakeAt(shell) !== null;
}

/** A snooze acknowledges the run already requested, including its eventual result. */
function completionWakeAt(shell: ThreadSnoozeShell): string | null {
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (
    shell.snoozedAt != null &&
    (latestRun?.state === "completed" || latestRun?.status === "completed") &&
    latestRun.requestedAt != null &&
    Date.parse(latestRun.requestedAt) > Date.parse(shell.snoozedAt) &&
    latestRun.completedAt != null &&
    Date.parse(latestRun.completedAt) > Date.parse(shell.snoozedAt)
  ) {
    return latestRun.completedAt;
  }
  return null;
}

// V2 runtime.updatedAt includes metadata writes; prefer the failed run's completion.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed" && latestRun.completedAt != null) {
    return latestRun.completedAt;
  }
  return runtime.updatedAt ?? null;
}

export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
    | "source"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  // The server rejects snoozing even for nonblocking questions.
  if (shell.source?.pendingRuntimeRequest != null) return false;
  if (shell.pendingSubagentRequest != null) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    const completedAt = completionWakeAt(shell);
    if (completedAt !== null) return completedAt;
    // An old failure must not replace the activity time of an approval or input wake.
    const failedAt = failureEdgeAt(shell);
    if (
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt))
    ) {
      return failedAt;
    }
    const runtime = shell.runtime ?? shell.session ?? null;
    return runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

// T3-CUSTOM(expbkt3): the fork's "a merge never settles" rewrite was retired in favour of
// upstream's `autoSettleOnMerge` option; the fork keeps that behaviour by defaulting
// `sidebarAutoSettleOnMerge` to false in contracts/settings.ts.
/**
 * Settled resolution over the server-backed settled lifecycle. Activity
 * blockers (pending approval/user-input, a live session, an unadjudicated
 * queued turn) are checked first and hold a thread active regardless of any
 * override. Past the blockers, the explicit user override (thread.settle /
 * thread.unsettle commands, projected into settledOverride + settledAt)
 * wins in both directions; without one, a thread can auto-settle on a
 * merged PR or always on a closed PR (both only while the terminal state is
 * the thread's latest event, see changeRequestAutoSettles), or settles on
 * inactivity past the window.
 * An open PR blocks the inactivity path entirely. The server
 * un-settles on real activity (user message, session start, approval/
 * user-input request), so an override never goes stale silently.
 */
export function effectiveSettled(
  shell: ThreadActivitySource & {
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
    readonly settledOverride: "settled" | "active" | null;
    readonly settledAt: string | null;
  },
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge?: boolean;
    readonly changeRequest?: ChangeRequestSettleSource | null;
  },
): boolean {
  // Blocked work must remain visible even when a user explicitly settled it.
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  const runtime = shell.runtime ?? shell.session;
  if (
    runtime?.status === "preparing" ||
    runtime?.status === "starting" ||
    runtime?.status === "running"
  )
    return false;
  if (hasQueuedTurnStart(shell, { now: options.now })) {
    // The queued-turn blocker alone is forgivable: it is clock-derived, and
    // list callers pass a coarser `now` than the settle action used. When
    // the server already adjudicated the queued message by accepting a
    // settle after it (settledAt stamps server accept time), trust that
    // ruling — otherwise a settle near the grace boundary leaves the row
    // pinned active until the caller's clock ticks over. A message NEWER
    // than settledAt is genuinely new work and keeps the block until the
    // server's auto-unsettle lands.
    const serverAdjudicated =
      shell.settledOverride === "settled" &&
      shell.settledAt !== null &&
      shell.latestUserMessageAt != null &&
      Date.parse(shell.settledAt) >= Date.parse(shell.latestUserMessageAt);
    if (!serverAdjudicated) return false;
  }
  if (shell.settledOverride === "settled") return true;
  // "active" is the explicit keep-active pin: it suppresses auto-settle
  // until real activity clears it server-side.
  if (shell.settledOverride === "active") return false;
  if (
    changeRequestAutoSettles(options.changeRequest, {
      autoSettleOnMerge: options.autoSettleOnMerge,
      thread: shell,
    })
  ) {
    return true;
  }
  // An open PR is unfinished business regardless of how long the thread has
  // been quiet: review can take days, and hiding the thread would bury the
  // work waiting on it. A configured merge, a close, or an explicit user
  // settle resolves it.
  if (options.changeRequest?.state === "open") return false;
  if (options.autoSettleAfterDays === null) return false;

  const lastActivityAt = threadLastActivityAt(shell);
  if (lastActivityAt === null) return false;

  // threadLastActivityAt only returns candidates whose Date.parse beat
  // -Infinity, so this parse is a real number; a malformed `now` yields NaN,
  // the comparison is false, and the thread stays active (never a surprise
  // auto-settle on bad input).
  return (
    Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
  );
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + HOUR_MS));
  const inThreeHours = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + 3 * HOUR_MS));
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: snoozeTimeOfDayLabel(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime()) {
    presets.push({
      id: "next-week",
      label: "Next week",
      whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
      snoozedUntil: nextWeek.toISOString(),
    });
  }

  return presets;
}

export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
