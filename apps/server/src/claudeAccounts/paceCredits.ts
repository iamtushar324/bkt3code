/**
 * T3-CUSTOM(expbkt3): Claude account profiles — pace to reset and API credits.
 *
 * `claude-autoswitch --status --json` sends, per profile, a `pace` object
 * (subscription seats) and a `credits` object (the `kind: api_fallback`
 * account only). Older switchers send neither. Both are validated field by
 * field here: a non-finite number, an unknown enum string or a bad date is
 * dropped, and an object without its required enum is dropped whole, so the
 * picker never shows a line built from bad data.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type {
  ClaudeAccountCredits,
  ClaudeAccountCreditsState,
  ClaudeAccountCreditsStatus,
  ClaudeAccountPace,
  ClaudeAccountPaceStatus,
} from "@t3tools/contracts";

const PACE_STATUSES: ReadonlyArray<ClaudeAccountPaceStatus> = [
  "untouched",
  "underused",
  "on_pace",
  "overused",
  "spent",
  "unknown",
];
const CREDITS_STATES: ReadonlyArray<ClaudeAccountCreditsState> = [
  "ok",
  "error",
  "pending",
  "no_admin_key",
];
const CREDITS_STATUSES: ReadonlyArray<ClaudeAccountCreditsStatus> = [
  "underused",
  "on_pace",
  "overused",
  "spent",
  "unknown",
];

type Fields = Readonly<Record<string, unknown>>;

function asObject(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlyArray<T>): T | undefined {
  return typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/** Adds `key: value` only when the value is defined (exactOptionalPropertyTypes). */
function put<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function paceFrom(raw: unknown): ClaudeAccountPace | undefined {
  const fields = asObject(raw);
  const known = fields?.known;
  if (fields === undefined || typeof known !== "boolean") return undefined;
  const status = oneOf(fields.status, PACE_STATUSES);
  if (status === undefined) return undefined;
  const used = finite(fields.used_pct);
  return {
    known,
    ...put("why", text(fields.why)),
    ...put("cap", text(fields.cap) || undefined),
    ...put("elapsedDays", nonNegative(fields.elapsed_days)),
    ...put("usedPercent", used === undefined ? undefined : Math.min(100, Math.max(0, used))),
    ...put("drrPercentPerDay", nonNegative(fields.drr_pct_per_day)),
    ...put("projectedPercent", nonNegative(fields.projected_pct)),
    status,
  };
}

export function creditsFrom(raw: unknown): ClaudeAccountCredits | undefined {
  const fields = asObject(raw);
  if (fields === undefined) return undefined;
  const state = oneOf(fields.state, CREDITS_STATES);
  if (state === undefined) return undefined;
  const fetchedAtMs = nonNegative(fields.fetched_at_ms);
  const cycle = text(fields.cycle_start);
  const cycleStart = cycle !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(cycle) ? cycle : undefined;
  return {
    state,
    ...put("detail", text(fields.detail)),
    ...put(
      "fetchedAtMs",
      fetchedAtMs !== undefined && Number.isInteger(fetchedAtMs) ? fetchedAtMs : undefined,
    ),
    ...put("budgetUsd", finite(fields.budget_usd)),
    ...put("spentUsd", finite(fields.spent_usd)),
    ...put("leftUsd", finite(fields.left_usd)),
    ...put("cycleStart", cycleStart),
    ...put("expiresAt", iso(fields.expires_at)),
    ...put("daysLeft", nonNegative(fields.days_left)),
    ...put("allowedUsdPerDay", finite(fields.allowed_usd_per_day)),
    ...put("drrUsdPerDay", nonNegative(fields.drr_usd_per_day)),
    ...put("runsOutAt", iso(fields.runs_out_at)),
    ...put("status", oneOf(fields.status, CREDITS_STATUSES)),
  };
}

/**
 * The `pace` and `credits` fields of one account's status. Credits belong to
 * the API-credit fallback only; a seat never carries them.
 */
export function paceAndCredits(raw: {
  readonly kind?: string | null;
  readonly pace?: unknown;
  readonly credits?: unknown;
}): { pace?: ClaudeAccountPace; credits?: ClaudeAccountCredits } {
  const isApiFallback = raw.kind === "api_fallback";
  return {
    ...put("pace", isApiFallback ? undefined : paceFrom(raw.pace)),
    ...put("credits", isApiFallback ? creditsFrom(raw.credits) : undefined),
  };
}
