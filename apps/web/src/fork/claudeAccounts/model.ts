/**
 * T3-CUSTOM(expbkt3): what the composer's Claude account picker shows.
 *
 * Pure view models over the server's account snapshot and the thread's
 * account choice. The wire carries percent USED; everything here speaks
 * percent REMAINING, which is what the user reads ("40%" = 40% of the weekly
 * limit left).
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
export const AUTO_ACCOUNT_DESCRIPTION =
  "Spreads new sessions across accounts with the most limit left; stays on one account per thread";
export const SWITCH_RESTARTS_CACHE_HINT = "Switching accounts restarts this thread's prompt cache.";
export const PENDING_RESTART_HINT = "Applies after this turn";

/** Five-hour usage at or above this is "near limit". */
export const NEAR_LIMIT_USED_PERCENT = 80;

interface UsageWindow {
  readonly usedPercent: number;
  readonly resetsAt?: string;
}

/** Percent left in a window, rounded; null when the window is unknown. */
export function remaining(win: UsageWindow | undefined): number | null {
  if (win === undefined) return null;
  return Math.round(100 - Math.max(0, Math.min(100, win.usedPercent)));
}

/** `resets in 2h 13m`, `resets now`, or null when the reset time is unknown. */
export function resetsIn(win: UsageWindow | undefined, now: number): string | null {
  if (win?.resetsAt === undefined) return null;
  const at = Date.parse(win.resetsAt);
  if (!Number.isFinite(at)) return null;
  return at <= now ? "resets now" : `resets in ${formatDuration(at - now)}`;
}

/**
 * Whether a 5-hour or weekly window is spent. Read from the numbers, never
 * from the switcher's `why` text, which is free-form (`over weekly 95% >= 95%`,
 * `near trip: five_hour 83% >= 80%`, `excluded`, …). A spent scoped window
 * (one model's weekly allowance) is not this: the account still runs every
 * other model, so it gets its own chip instead.
 */
export function isAtLimit(status: ClaudeAccountStatus): boolean {
  if ((status.fiveHour?.usedPercent ?? 0) >= 100) return true;
  return (status.weekly?.usedPercent ?? 0) >= 100;
}

export function isNearLimit(status: ClaudeAccountStatus): boolean {
  return !isAtLimit(status) && (status.fiveHour?.usedPercent ?? 0) >= NEAR_LIMIT_USED_PERCENT;
}

export type AccountWarning = "near" | "limit" | "logged_out";

export function accountWarning(status: ClaudeAccountStatus | undefined): AccountWarning | null {
  if (status === undefined) return null;
  if (status.auth === "logged_out") return "logged_out";
  if (isAtLimit(status)) return "limit";
  if (isNearLimit(status)) return "near";
  return null;
}

export type AccountChipTone = "destructive" | "warning" | "muted";

export interface AccountChip {
  readonly id: "logged-out" | "at-limit" | "near-limit" | "scoped-spent" | "not-used" | "in-use";
  readonly label: string;
  readonly tone: AccountChipTone;
  /** The longer explanation shown on hover: the switcher's own reason. */
  readonly detail?: string;
}

export const NOT_USED_BY_AUTO_LABEL = "not used by Auto";

/**
 * Why Auto skips this account, when no number-driven chip already says so.
 * A logged-out or spent account is self-explanatory; anything else (a trip
 * threshold, an exclusion, out of rotation) shows the switcher's reason.
 */
export function autoSkipReason(status: ClaudeAccountStatus): string | null {
  if (status.eligible || status.auth === "logged_out" || isAtLimit(status)) return null;
  return status.why.trim() || NOT_USED_BY_AUTO_LABEL;
}

/** State chips for one account row, most severe first. */
export function accountChips(status: ClaudeAccountStatus): ReadonlyArray<AccountChip> {
  const chips: AccountChip[] = [];
  if (status.auth === "logged_out") {
    chips.push({ id: "logged-out", label: "logged out", tone: "destructive" });
  }
  if (isAtLimit(status)) {
    chips.push({ id: "at-limit", label: "at limit", tone: "destructive" });
  } else if (isNearLimit(status)) {
    chips.push({ id: "near-limit", label: "near limit", tone: "warning" });
  }
  if (status.scoped !== undefined && status.scoped.usedPercent >= 100) {
    chips.push({ id: "scoped-spent", label: `${status.scoped.label} spent`, tone: "warning" });
  }
  const skipped = autoSkipReason(status);
  if (skipped !== null) {
    chips.push({ id: "not-used", label: NOT_USED_BY_AUTO_LABEL, tone: "muted", detail: skipped });
  }
  if (status.sessions > 0) {
    chips.push({ id: "in-use", label: `in use by ${status.sessions}`, tone: "muted" });
  }
  return chips;
}

/** Ranked accounts first (1 = best), unranked last, then by name. */
export function orderAccounts(
  profiles: ReadonlyArray<ClaudeAccountStatus>,
): ReadonlyArray<ClaudeAccountStatus> {
  return [...profiles].toSorted((left, right) => {
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
      readonly weeklyRemaining: number | null;
      readonly fiveHourRemaining: number | null;
      readonly auto: boolean;
      readonly warn: AccountWarning | null;
      /** The switcher's reason when Auto would not place a session here. */
      readonly autoSkip: string | null;
    };

/** What the composer trigger shows: "Auto" until Auto has placed the thread. */
export function triggerView(
  snapshot: ClaudeAccountsSnapshot | null,
  thread: ThreadClaudeAccount | null,
): TriggerView {
  const profile = effectiveProfile(thread);
  if (profile === undefined) return { kind: "auto-unresolved" };
  const status = findAccount(snapshot, profile);
  return {
    kind: "account",
    profile,
    label: status?.shortLabel || profile.slice(0, 1),
    weeklyRemaining: remaining(status?.weekly),
    fiveHourRemaining: remaining(status?.fiveHour),
    auto: thread?.mode.kind !== "profile",
    warn: accountWarning(status),
    autoSkip: status === undefined ? null : autoSkipReason(status),
  };
}

/** One line for the trigger's tooltip and accessible name. */
export function triggerTooltip(view: TriggerView): string {
  if (view.kind === "auto-unresolved") {
    return `${AUTO_ACCOUNT_LABEL} · picks an account when the thread starts`;
  }
  const parts = view.auto
    ? [AUTO_ACCOUNT_LABEL, `on ${view.profile}`]
    : [`${view.profile} (pinned)`];
  if (view.weeklyRemaining !== null) parts.push(`weekly ${view.weeklyRemaining}% left`);
  if (view.fiveHourRemaining !== null) parts.push(`5-hour ${view.fiveHourRemaining}% left`);
  if (view.warn === "logged_out") parts.push("logged out");
  else if (view.warn === "limit") parts.push("at limit");
  else if (view.warn === "near") parts.push("near limit");
  if (view.autoSkip !== null) parts.push(`${NOT_USED_BY_AUTO_LABEL} (${view.autoSkip})`);
  return parts.join(" · ");
}

export interface AccountWindowView {
  readonly id: "fiveHour" | "weekly" | "scoped";
  readonly label: string;
  readonly remaining: number;
  readonly resetsIn: string | null;
}

export interface AccountRowView {
  readonly name: string;
  readonly shortLabel: string;
  readonly emailMasked: string | null;
  readonly windows: ReadonlyArray<AccountWindowView>;
  readonly sessions: number;
  readonly chips: ReadonlyArray<AccountChip>;
  /** A logged-out account cannot be picked. */
  readonly disabled: boolean;
  /** The thread is pinned here. */
  readonly checked: boolean;
  /** The thread's session runs (or last ran) here. */
  readonly current: boolean;
  /** The host-wide default account. */
  readonly elected: boolean;
}

function windowView(
  id: AccountWindowView["id"],
  label: string,
  win: UsageWindow | undefined,
  now: number,
): AccountWindowView | null {
  const left = remaining(win);
  if (left === null) return null;
  return { id, label, remaining: left, resetsIn: resetsIn(win, now) };
}

export function accountRows(
  snapshot: ClaudeAccountsSnapshot | null,
  thread: ThreadClaudeAccount | null,
  now: number,
): ReadonlyArray<AccountRowView> {
  if (snapshot === null) return [];
  const pinned = thread?.mode.kind === "profile" ? thread.mode.profile : null;
  const current = thread?.resolvedProfile ?? null;
  return orderAccounts(snapshot.profiles).map((status) => ({
    name: status.name,
    shortLabel: status.shortLabel || status.name.slice(0, 1),
    emailMasked: status.emailMasked ?? null,
    windows: [
      windowView("fiveHour", "5h", status.fiveHour, now),
      windowView("weekly", "Week", status.weekly, now),
      status.scoped ? windowView("scoped", status.scoped.label, status.scoped, now) : null,
    ].filter((view): view is AccountWindowView => view !== null),
    sessions: status.sessions,
    chips: accountChips(status),
    disabled: status.auth === "logged_out",
    checked: pinned === status.name,
    current: current === status.name,
    elected: status.elected,
  }));
}

export function isAutoMode(thread: ThreadClaudeAccount | null): boolean {
  return thread === null || thread.mode.kind === "auto";
}

export function modeEquals(left: ClaudeAccountMode, right: ClaudeAccountMode): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "auto" || (right.kind === "profile" && left.profile === right.profile);
}

/**
 * Whether moving the thread to `target` leaves the account its session is on,
 * which costs the provider's prompt cache. Auto keeps a placed thread where it
 * is, so only a pin to another account counts.
 */
export function switchRestartsCache(
  thread: ThreadClaudeAccount | null,
  target: ClaudeAccountMode,
): boolean {
  const current = thread?.resolvedProfile;
  return current !== undefined && target.kind === "profile" && target.profile !== current;
}

export const LOADING_ACCOUNTS_LINE = "Loading account data…";

/**
 * The muted line shown when there are no account figures: still loading
 * (before the server's first poll, which reports no reason or a `loading…`
 * one), or the host switcher cannot report them.
 */
export function unavailableLine(snapshot: ClaudeAccountsSnapshot): string | null {
  if (snapshot.available) return null;
  const reason = snapshot.unavailableReason?.trim();
  if (!reason || /^loading/i.test(reason)) return LOADING_ACCOUNTS_LINE;
  return `Account data unavailable (${reason}) — Auto uses the host's current account`;
}
