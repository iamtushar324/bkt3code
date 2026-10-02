/**
 * T3-CUSTOM(expbkt3): what the composer's Claude account picker shows.
 *
 * Pure view models over the server's account snapshot and the thread's
 * account choice. Everything speaks percent USED, like the wire and like the
 * Claude Accounts dashboard (`tools/claude-accounts` in bk-docs), whose bar
 * bands and tags this mirrors: green under 60% used, amber from 60% to the
 * trip line, red at or past it.
 */
import type {
  ClaudeAccountMode,
  ClaudeAccountsSnapshot,
  ClaudeAccountStatus,
  ThreadClaudeAccount,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/usageLimits";

/** Distinct from the runtime "Auto" modes and Cursor's "auto" model. */
export const AUTO_ACCOUNT_LABEL = "Auto (account)";
export const AUTO_ACCOUNT_UNPLACED = "Picks an account on the first message";
export const AUTO_ACCOUNT_RULE = "new sessions go to the account with the most room";
export const SWITCH_RESTARTS_SESSION_HINT =
  "Switching restarts this thread's session on the next message";
export const PENDING_RESTART_HINT = "Applies after this turn";

/** Bar bands, as on the dashboard: only the trip lines are policy. */
export const WARN_USED_PERCENT = 60;
export const FIVE_HOUR_TRIP_PERCENT = 90;
export const WEEKLY_TRIP_PERCENT = 95;

export type UsageBand = "ok" | "warn" | "bad";

/**
 * The composer trigger's two rings (outer = 5-hour, inner = weekly) stay
 * quiet until they matter: yellow from 75% used, red from 90%.
 */
export const RING_WARN_PERCENT = 75;
export const RING_BAD_PERCENT = 90;

export type RingTone = "quiet" | "warn" | "bad";

export function ringTone(usedPercent: number | null): RingTone {
  if (usedPercent === null) return "quiet";
  if (usedPercent >= RING_BAD_PERCENT) return "bad";
  if (usedPercent >= RING_WARN_PERCENT) return "warn";
  return "quiet";
}

interface UsageWindow {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

/** Percent used in a window, rounded and clamped; null when unknown. */
export function used(win: UsageWindow | undefined): number | null {
  if (win === undefined) return null;
  return Math.round(Math.max(0, Math.min(100, win.usedPercent)));
}

export function usageBand(usedPercent: number, tripPercent: number): UsageBand {
  if (usedPercent >= tripPercent) return "bad";
  if (usedPercent >= WARN_USED_PERCENT) return "warn";
  return "ok";
}

function resetAt(win: UsageWindow | undefined): number | null {
  if (win?.resetsAt === undefined) return null;
  const at = Date.parse(win.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/** `resets 2h 13m`, `resets now`, or null when the reset time is unknown. */
export function resetsIn(win: UsageWindow | undefined, now: number): string | null {
  const at = resetAt(win);
  if (at === null) return null;
  return at <= now ? "resets now" : `resets in ${formatDuration(at - now)}`;
}

/**
 * Whether a 5-hour or weekly window is spent. Read from the numbers, never
 * from the switcher's free-form `why`. A spent scoped window (one model's
 * weekly allowance) is not this: the account still runs every other model.
 */
export function isAtLimit(status: ClaudeAccountStatus): boolean {
  return (used(status.fiveHour) ?? 0) >= 100 || (used(status.weekly) ?? 0) >= 100;
}

/** Past a trip line: Auto will not place a new session here. */
export function isOverLimit(status: ClaudeAccountStatus): boolean {
  if (isAtLimit(status)) return true;
  if ((used(status.fiveHour) ?? 0) >= FIVE_HOUR_TRIP_PERCENT) return true;
  return (used(status.weekly) ?? 0) >= WEEKLY_TRIP_PERCENT;
}

export function isNearLimit(status: ClaudeAccountStatus): boolean {
  return !isOverLimit(status) && (used(status.fiveHour) ?? 0) >= 80;
}

/**
 * How long until an over-limit account is usable again: the latest reset
 * among the windows past their trip line (every one of them must clear).
 */
export function recoversIn(status: ClaudeAccountStatus, now: number): string | null {
  if (!isOverLimit(status)) return null;
  const blocking: Array<UsageWindow | undefined> = [];
  if ((used(status.fiveHour) ?? 0) >= FIVE_HOUR_TRIP_PERCENT) blocking.push(status.fiveHour);
  if ((used(status.weekly) ?? 0) >= WEEKLY_TRIP_PERCENT) blocking.push(status.weekly);
  const resets = blocking.map(resetAt);
  if (resets.length === 0 || resets.some((at) => at === null)) return null;
  const at = Math.max(...(resets as number[]));
  return at <= now ? "recovers now" : `recovers ${formatDuration(at - now)}`;
}

export type AccountWarning = "near" | "limit" | "logged_out";

export function accountWarning(status: ClaudeAccountStatus | undefined): AccountWarning | null {
  if (status === undefined) return null;
  if (status.auth === "logged_out") return "logged_out";
  if (isOverLimit(status)) return "limit";
  if (isNearLimit(status)) return "near";
  return null;
}

export type AccountTagTone = "bad" | "warn" | "muted";

export interface AccountTag {
  readonly id: "logged-out" | "over" | "near-limit" | "scoped-spent" | "not-used";
  readonly label: string;
  readonly tone: AccountTagTone;
  /** The longer explanation shown on hover: the switcher's own reason. */
  readonly detail?: string;
}

export const NOT_USED_BY_AUTO_LABEL = "not used by Auto";

/**
 * Which trip line an over-limit account is past, from the numbers (the
 * switcher's `why` may name an exclusion first): `five_hour 94% ≥ 90%`.
 */
function overReason(status: ClaudeAccountStatus): string {
  const fiveHour = used(status.fiveHour) ?? 0;
  const weekly = used(status.weekly) ?? 0;
  if (fiveHour >= FIVE_HOUR_TRIP_PERCENT) {
    return `five_hour ${fiveHour}% ≥ ${FIVE_HOUR_TRIP_PERCENT}%`;
  }
  return `weekly ${weekly}% ≥ ${WEEKLY_TRIP_PERCENT}%`;
}

/** The switcher's reason in the dashboard's spelling: `≥`, not `>=`. */
function prettyWhy(why: string): string {
  return why.trim().replaceAll(">=", "≥");
}

/**
 * The one status tag a row shows, most severe first, like the dashboard's
 * `over: five_hour 94% ≥ 90%` tag. Null for a healthy account.
 */
export function statusTag(status: ClaudeAccountStatus): AccountTag | null {
  if (status.auth === "logged_out") return { id: "logged-out", label: "logged out", tone: "bad" };
  if (isOverLimit(status)) {
    const label = `over: ${overReason(status)}`;
    return { id: "over", label, tone: "bad", detail: label };
  }
  if (isNearLimit(status)) {
    return {
      id: "near-limit",
      label: "near limit",
      tone: "warn",
      detail: prettyWhy(status.why) || "5-hour window nearly used",
    };
  }
  if (status.scoped !== undefined && status.scoped.usedPercent >= 100) {
    return { id: "scoped-spent", label: `${status.scoped.label} spent`, tone: "warn" };
  }
  if (!status.eligible) {
    return {
      id: "not-used",
      label: NOT_USED_BY_AUTO_LABEL,
      tone: "muted",
      detail: prettyWhy(status.why) || NOT_USED_BY_AUTO_LABEL,
    };
  }
  return null;
}

/** An account a new session could run on now. */
export function isUsable(status: ClaudeAccountStatus): boolean {
  return status.auth !== "logged_out" && !isOverLimit(status);
}

/** Usable accounts first, each group in rank order (unranked last), as on the dashboard. */
export function orderAccounts(
  profiles: ReadonlyArray<ClaudeAccountStatus>,
): ReadonlyArray<ClaudeAccountStatus> {
  return [...profiles].toSorted((left, right) => {
    const leftUsable = isUsable(left) ? 0 : 1;
    const rightUsable = isUsable(right) ? 0 : 1;
    if (leftUsable !== rightUsable) return leftUsable - rightUsable;
    const leftRank = left.rank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.rank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.name.localeCompare(right.name);
  });
}

export function findAccount(
  snapshot: ClaudeAccountsSnapshot | null,
  profile: string | undefined,
): ClaudeAccountStatus | undefined {
  if (snapshot === null || profile === undefined) return undefined;
  return snapshot.profiles.find((status) => status.name === profile);
}

/** The account the thread runs on (pinned) or last ran on (auto). */
export function effectiveProfile(thread: ThreadClaudeAccount | null): string | undefined {
  if (thread === null) return undefined;
  return thread.mode.kind === "profile" ? thread.mode.profile : thread.resolvedProfile;
}

export type TriggerView =
  | { readonly kind: "auto-unresolved" }
  | {
      readonly kind: "account";
      readonly profile: string;
      /** The badge letter(s) on the Claude icon. */
      readonly label: string;
      readonly weeklyUsed: number | null;
      readonly weeklyBand: UsageBand | null;
      readonly fiveHourUsed: number | null;
      readonly auto: boolean;
      readonly warn: AccountWarning | null;
      readonly tag: AccountTag | null;
    };

/** What the composer trigger shows: "Auto" until Auto has placed the thread. */
export function triggerView(
  snapshot: ClaudeAccountsSnapshot | null,
  thread: ThreadClaudeAccount | null,
): TriggerView {
  const profile = effectiveProfile(thread);
  if (profile === undefined) return { kind: "auto-unresolved" };
  const status = findAccount(snapshot, profile);
  const weeklyUsed = used(status?.weekly);
  return {
    kind: "account",
    profile,
    label: status?.shortLabel || profile.slice(0, 1),
    weeklyUsed,
    weeklyBand: weeklyUsed === null ? null : usageBand(weeklyUsed, WEEKLY_TRIP_PERCENT),
    fiveHourUsed: used(status?.fiveHour),
    auto: thread?.mode.kind !== "profile",
    warn: accountWarning(status),
    tag: status === undefined ? null : statusTag(status),
  };
}

/** One line for the trigger's tooltip and accessible name. */
export function triggerTooltip(view: TriggerView): string {
  if (view.kind === "auto-unresolved") return `${AUTO_ACCOUNT_LABEL} · ${AUTO_ACCOUNT_UNPLACED}`;
  const parts = view.auto
    ? [AUTO_ACCOUNT_LABEL, `on ${view.profile}`]
    : [`${view.profile} (pinned)`];
  if (view.weeklyUsed !== null) parts.push(`week ${view.weeklyUsed}% used`);
  if (view.fiveHourUsed !== null) parts.push(`5-hour ${view.fiveHourUsed}% used`);
  if (view.tag !== null) parts.push(view.tag.detail ?? view.tag.label);
  return parts.join(" · ");
}

export interface AccountWindowView {
  readonly id: "fiveHour" | "weekly" | "scoped";
  readonly label: string;
  readonly used: number;
  readonly band: UsageBand;
  readonly resetsIn: string | null;
}

export interface AccountRowView {
  readonly name: string;
  readonly shortLabel: string;
  readonly emailMasked: string | null;
  readonly windows: ReadonlyArray<AccountWindowView>;
  readonly sessions: number;
  readonly tag: AccountTag | null;
  readonly recoversIn: string | null;
  /** A logged-out account cannot be picked. */
  readonly disabled: boolean;
  /** The thread's session runs (or last ran) here. */
  readonly current: boolean;
}

function windowView(
  id: AccountWindowView["id"],
  label: string,
  win: UsageWindow | undefined,
  tripPercent: number,
  now: number,
): AccountWindowView | null {
  const usedPercent = used(win);
  if (usedPercent === null) return null;
  return {
    id,
    label,
    used: usedPercent,
    band: usageBand(usedPercent, tripPercent),
    resetsIn: resetsIn(win, now),
  };
}

export function accountRows(
  snapshot: ClaudeAccountsSnapshot | null,
  thread: ThreadClaudeAccount | null,
  now: number,
): ReadonlyArray<AccountRowView> {
  if (snapshot === null) return [];
  const current = effectiveProfile(thread) ?? null;
  // Admins are sent accounts they may not use (to manage access); offer only
  // the usable ones, plus the thread's own so the current choice still shows.
  const offered = snapshot.profiles.filter(
    (status) => status.allowed !== false || status.name === current,
  );
  return orderAccounts(offered).map((status) => ({
    name: status.name,
    shortLabel: status.shortLabel || status.name.slice(0, 1),
    emailMasked: status.emailMasked ?? null,
    windows: [
      windowView("fiveHour", "5-hour", status.fiveHour, FIVE_HOUR_TRIP_PERCENT, now),
      windowView("weekly", "Week", status.weekly, WEEKLY_TRIP_PERCENT, now),
      status.scoped
        ? windowView("scoped", status.scoped.label, status.scoped, WEEKLY_TRIP_PERCENT, now)
        : null,
    ].filter((view): view is AccountWindowView => view !== null),
    sessions: status.sessions,
    tag: statusTag(status),
    recoversIn: recoversIn(status, now),
    disabled: status.auth === "logged_out",
    current: current === status.name,
  }));
}

/** The muted line under "Auto (account)". */
export function autoRowDetail(thread: ThreadClaudeAccount | null): string {
  const resolved = thread?.mode.kind === "auto" ? thread.resolvedProfile : undefined;
  return resolved ? `On ${resolved} · ${AUTO_ACCOUNT_RULE}` : AUTO_ACCOUNT_UNPLACED;
}

export function isAutoMode(thread: ThreadClaudeAccount | null): boolean {
  return thread === null || thread.mode.kind === "auto";
}

export function modeEquals(left: ClaudeAccountMode, right: ClaudeAccountMode): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "auto" || (right.kind === "profile" && left.profile === right.profile);
}

/**
 * Whether picking `target` moves the thread off the account its session is
 * on, which restarts the session (the prompt cache itself survives: every
 * account is a seat in the same organisation). Auto keeps a placed thread
 * where it is, so only a pin to another account counts.
 */
export function switchRestartsSession(
  thread: ThreadClaudeAccount | null,
  target: ClaudeAccountMode,
): boolean {
  const current = thread?.resolvedProfile;
  return current !== undefined && target.kind === "profile" && target.profile !== current;
}

export const LOADING_ACCOUNTS_LINE = "Loading account data…";

/**
 * The muted line shown when there are no account figures: still loading
 * (before the server's first poll), or the host switcher cannot report them.
 */
export function unavailableLine(snapshot: ClaudeAccountsSnapshot): string | null {
  const reason = snapshot.unavailableReason?.trim();
  // Before its first poll the server reports available + "loading" with no profiles.
  if (reason !== undefined && /^loading/i.test(reason)) return LOADING_ACCOUNTS_LINE;
  if (snapshot.available) return snapshot.profiles.length === 0 ? LOADING_ACCOUNTS_LINE : null;
  if (!reason) return LOADING_ACCOUNTS_LINE;
  return `Account data unavailable (${reason}) — Auto uses the host's current account`;
}
