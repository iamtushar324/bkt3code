import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  describeSchedule,
  formatDuration,
  parseDuration,
  parseWeekdays,
  resolveWhen,
} from "./when.ts";

// Sunday 11 October 2026, 18:00 UTC.
const NOW_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-11T18:00:00Z"));
const serverIsUtc = ["UTC", "Etc/UTC"].includes(DateTime.zoneToString(DateTime.zoneMakeLocal()));

const resolved = (input: Parameters<typeof resolveWhen>[0]) => {
  const when = resolveWhen(input, NOW_MS);
  if (Result.isFailure(when)) throw new Error(when.failure);
  return when.success;
};

describe("parseDuration", () => {
  it("reads compact and spelled-out durations", () => {
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("2 hours")).toBe(7_200_000);
    expect(parseDuration("1d 3h")).toBe(97_200_000);
    expect(parseDuration("1w")).toBe(604_800_000);
    expect(parseDuration("90s")).toBe(90_000);
  });

  it("rejects what is not a duration", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("10")).toBeNull();
    expect(parseDuration("5 parsecs")).toBeNull();
  });

  it("formats back in whole minutes", () => {
    expect(formatDuration(5_400_000)).toBe("1h 30m");
    expect(formatDuration(97_200_000)).toBe("1d 3h");
  });
});

describe("parseWeekdays", () => {
  it("accepts names, numbers and the weekday shortcuts", () => {
    expect(parseWeekdays(["mon", "Friday", 0])).toEqual(Result.succeed([0, 1, 5]));
    expect(parseWeekdays(["weekdays"])).toEqual(Result.succeed([1, 2, 3, 4, 5]));
    expect(Result.isFailure(parseWeekdays(["someday"]))).toBe(true);
    expect(Result.isFailure(parseWeekdays([7]))).toBe(true);
  });
});

describe("resolveWhen", () => {
  it("makes in and at one-time intervals", () => {
    expect(resolved({ in: "10m" })).toEqual({
      schedule: { type: "interval", everyMs: 600_000 },
      runOnce: true,
      timeZone: undefined,
    });
    const at = resolved({ at: "2026-10-11T20:30:00Z" });
    expect(at.schedule).toEqual({ type: "interval", everyMs: 9_000_000 });
    expect(at.runOnce).toBe(true);
  });

  it("reads an at without an offset in the given time zone", () => {
    // 09:00 in Kolkata on 12 October is 03:30 UTC: 9.5 hours after now.
    const at = resolved({ at: "2026-10-12T09:00", timeZone: "Asia/Kolkata" });
    expect(at.schedule).toEqual({ type: "interval", everyMs: 9.5 * 3_600_000 });
    expect(at.timeZone).toBe("Asia/Kolkata");
  });

  it("finds the next HH:MM in the given time zone", () => {
    // Now is 23:30 in Kolkata, so 09:00 is tomorrow.
    expect(resolved({ at: "09:00", timeZone: "Asia/Kolkata" }).schedule).toEqual({
      type: "interval",
      everyMs: 9.5 * 3_600_000,
    });
  });

  it("repeats every", () => {
    expect(resolved({ every: "2h" })).toEqual({
      schedule: { type: "interval", everyMs: 7_200_000 },
      runOnce: false,
      timeZone: undefined,
    });
  });

  it.skipIf(!serverIsUtc)("converts a daily time and its weekdays to server time", () => {
    // 09:00 Monday to Friday in Kolkata is 03:30 the same days in UTC.
    expect(resolved({ daily: "09:00", weekdays: ["weekdays"], timeZone: "Asia/Kolkata" })).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "03:30", weekdays: [1, 2, 3, 4, 5] },
      runOnce: false,
      timeZone: "Asia/Kolkata",
    });
    // 02:00 Monday in Kolkata is 20:30 Sunday in UTC.
    expect(
      resolved({ daily: "02:00", weekdays: ["mon"], timeZone: "Asia/Kolkata" }).schedule,
    ).toEqual({ type: "fixed_time", timeOfDay: "20:30", weekdays: [0] });
  });

  it.skipIf(!serverIsUtc)("describes a converted daily time in both zones", () => {
    expect(
      describeSchedule(
        { type: "fixed_time", timeOfDay: "03:30", weekdays: [1, 2, 3, 4, 5] },
        { timeZone: "Asia/Kolkata", nowMs: NOW_MS },
      ),
    ).toBe("daily 03:30 UTC on mon, tue, wed, thu, fri (09:00 Asia/Kolkata)");
  });

  it("refuses unclear input", () => {
    for (const input of [
      {},
      { in: "10m", every: "1h" },
      { in: "30s" },
      { every: "often" },
      { at: "2026-10-11T18:00:30Z" },
      { daily: "9am" },
      { weekdays: ["mon"], every: "1h" },
      { daily: "09:00", timeZone: "Mars/Olympus" },
    ]) {
      expect(Result.isFailure(resolveWhen(input, NOW_MS)), JSON.stringify(input)).toBe(true);
    }
  });

  it("describes schedules", () => {
    expect(
      describeSchedule({ type: "interval", everyMs: 600_000 }, { runOnce: true, nowMs: NOW_MS }),
    ).toBe("once");
    expect(describeSchedule({ type: "interval", everyMs: 7_200_000 }, { nowMs: NOW_MS })).toBe(
      "every 2h",
    );
    expect(describeSchedule({ type: "webhook", signature: null }, { nowMs: NOW_MS })).toBe(
      "on each request to its webhook URL",
    );
  });
});
