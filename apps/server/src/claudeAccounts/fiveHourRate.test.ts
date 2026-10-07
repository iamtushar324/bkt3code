/**
 * T3-CUSTOM(expbkt3): the 5-hour burn rate the server hands the switcher.
 */
import { assert, describe, it } from "@effect/vitest";

import {
  type FiveHourHistory,
  fiveHourRate,
  fiveHourRates,
  RATE_LOOKBACK_MS,
  recordFiveHour,
} from "./fiveHourRate.ts";

const WINDOW = "2026-10-07T12:30:00Z";
const MINUTE = 60_000;

describe("fiveHourRate", () => {
  it("rates the rise over the kept history in window points per hour", () => {
    const history: FiveHourHistory = new Map();
    recordFiveHour(history, "tushar", { atMs: 0, used: 20, resetsAt: WINDOW }, 0);
    recordFiveHour(
      history,
      "tushar",
      { atMs: 20 * MINUTE, used: 32, resetsAt: WINDOW },
      20 * MINUTE,
    );
    assert.closeTo(fiveHourRate(history.get("tushar"), 20 * MINUTE) ?? -1, 36, 1e-9);
  });

  it("needs five minutes of history and ignores a repeated reading", () => {
    const history: FiveHourHistory = new Map();
    recordFiveHour(history, "agent", { atMs: 0, used: 10, resetsAt: WINDOW }, 0);
    recordFiveHour(history, "agent", { atMs: 0, used: 10, resetsAt: WINDOW }, MINUTE);
    recordFiveHour(history, "agent", { atMs: 4 * MINUTE, used: 12, resetsAt: WINDOW }, 4 * MINUTE);
    assert.equal(history.get("agent")?.length, 2);
    assert.equal(fiveHourRate(history.get("agent"), 4 * MINUTE), undefined);
    assert.deepEqual(fiveHourRates(history, 4 * MINUTE), {});
  });

  it("starts over when the window rolls, and never reports negative burn", () => {
    const history: FiveHourHistory = new Map();
    recordFiveHour(history, "audit", { atMs: 0, used: 88, resetsAt: WINDOW }, 0);
    const next = "2026-10-07T17:30:00Z";
    recordFiveHour(history, "audit", { atMs: 10 * MINUTE, used: 2, resetsAt: next }, 10 * MINUTE);
    assert.equal(history.get("audit")?.length, 1);
    assert.equal(
      fiveHourRate(
        [
          { atMs: 0, used: 30, resetsAt: WINDOW },
          { atMs: 10 * MINUTE, used: 25, resetsAt: WINDOW },
        ],
        10 * MINUTE,
      ),
      0,
    );
  });

  it("forgets readings older than the lookback", () => {
    const history: FiveHourHistory = new Map();
    recordFiveHour(history, "barsha", { atMs: 0, used: 5, resetsAt: WINDOW }, 0);
    const later = RATE_LOOKBACK_MS + 10 * MINUTE;
    recordFiveHour(history, "barsha", { atMs: later, used: 50, resetsAt: WINDOW }, later);
    assert.equal(history.get("barsha")?.length, 1);
    assert.equal(fiveHourRate(history.get("barsha"), later), undefined);
  });
});
