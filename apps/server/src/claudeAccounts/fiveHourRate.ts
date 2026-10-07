/**
 * T3-CUSTOM(expbkt3): how fast each Claude account fills its 5-hour window.
 *
 * The switcher's `space-share-v1` placement skips an account whose 5-hour
 * window would fill before it resets, and it needs a burn rate for that. The
 * switcher reads only a snapshot, so the server, which polls it every ~15 s,
 * keeps a short history of each account's 5-hour reading and derives the rate.
 *
 * A reading is keyed by the time the CLI fetched it (status time minus its
 * age), so repeated polls of an unchanged cache add nothing. Readings from an
 * earlier window (a different `resets_at`) are dropped: a window rollover is a
 * reset, not negative burn.
 */

export interface FiveHourReading {
  /** When the CLI fetched this figure, epoch ms. */
  readonly atMs: number;
  /** Percent of the 5-hour window used. */
  readonly used: number;
  /** The window's reset time as sent by the switcher; identifies the window. */
  readonly resetsAt: string;
}

/** Only this much history counts towards the rate. */
export const RATE_LOOKBACK_MS = 45 * 60_000;
/** Below this span two readings are noise, not a rate. */
export const RATE_MIN_SPAN_MS = 5 * 60_000;

export type FiveHourHistory = Map<string, ReadonlyArray<FiveHourReading>>;

/** Adds one reading per profile, dropping old windows, duplicates and expired history. */
export function recordFiveHour(
  history: FiveHourHistory,
  profile: string,
  reading: FiveHourReading,
  nowMs: number,
): void {
  const kept = (history.get(profile) ?? []).filter(
    (prior) => prior.resetsAt === reading.resetsAt && prior.atMs >= nowMs - RATE_LOOKBACK_MS,
  );
  const last = kept.at(-1);
  if (last !== undefined && reading.atMs <= last.atMs) {
    history.set(profile, kept);
    return;
  }
  history.set(profile, [...kept, reading]);
}

/**
 * Window points per hour over the kept history, or undefined when the history
 * spans less than `RATE_MIN_SPAN_MS`. Never negative.
 */
export function fiveHourRate(
  readings: ReadonlyArray<FiveHourReading> | undefined,
  nowMs: number,
): number | undefined {
  const recent = (readings ?? []).filter((reading) => reading.atMs >= nowMs - RATE_LOOKBACK_MS);
  const first = recent[0];
  const last = recent.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const span = last.atMs - first.atMs;
  if (span < RATE_MIN_SPAN_MS) return undefined;
  return Math.max(0, ((last.used - first.used) / span) * 3_600_000);
}

/** Rates for every profile with enough history. */
export function fiveHourRates(history: FiveHourHistory, nowMs: number): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const [profile, readings] of history) {
    const rate = fiveHourRate(readings, nowMs);
    if (rate !== undefined) rates[profile] = rate;
  }
  return rates;
}
