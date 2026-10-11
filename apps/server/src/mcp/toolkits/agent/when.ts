/**
 * T3-CUSTOM(expbkt3): when a schedule runs, in the words an agent uses.
 *
 * `in: "10m"` and `at` run once, `every: "2h"` repeats, `daily: "09:00"` runs
 * at a wall-clock time on chosen weekdays, and `webhook` runs on each request
 * to the task's URL. Upstream stores only an interval, a server-time
 * `fixed_time` and a webhook, so a one-time run is an interval of the delay
 * that pauses after its run (`runOnce`), and a daily time given in another
 * time zone is converted to server time when it is saved.
 */
import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  type ScheduledTaskSchedule,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

const MINUTE_MS = 60_000;
const UNIT_MS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^(m|min|mins|minute|minutes)$/, MINUTE_MS],
  [/^(h|hr|hrs|hour|hours)$/, 60 * MINUTE_MS],
  [/^(d|day|days)$/, 24 * 60 * MINUTE_MS],
  [/^(w|wk|week|weeks)$/, 7 * 24 * 60 * MINUTE_MS],
];

/** "90m", "1h30m", "2 hours", "1d" in milliseconds; null when it does not read as one. */
export const parseDuration = (text: string): number | null => {
  const compact = text.trim().toLowerCase();
  if (compact.length === 0) return null;
  let total = 0;
  let rest = compact;
  const part = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*,?\s*/;
  while (rest.length > 0) {
    const match = part.exec(rest);
    if (match === null) return null;
    const unit = UNIT_MS.find(([pattern]) => pattern.test(match[2] ?? ""));
    if (unit === undefined) return null;
    total += Number(match[1]) * unit[1];
    rest = rest.slice(match[0].length);
  }
  return Math.round(total);
};

/** `ms` as "1d 2h 30m"; whole minutes. */
export const formatDuration = (ms: number): string => {
  let minutes = Math.round(ms / MINUTE_MS);
  const parts: Array<string> = [];
  for (const [size, label] of [
    [7 * 24 * 60, "w"],
    [24 * 60, "d"],
    [60, "h"],
    [1, "m"],
  ] as const) {
    if (minutes >= size) {
      parts.push(`${Math.floor(minutes / size)}${label}`);
      minutes %= size;
    }
  }
  return parts.length === 0 ? "0m" : parts.join(" ");
};

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Weekday names or numbers (0 is Sunday), or "weekdays" / "weekends", as sorted numbers. */
export const parseWeekdays = (
  entries: ReadonlyArray<string | number>,
): Result.Result<ReadonlyArray<number>, string> => {
  const days = new Set<number>();
  for (const entry of entries) {
    if (typeof entry === "number") {
      if (!Number.isInteger(entry) || entry < 0 || entry > 6) {
        return Result.fail(`Weekday ${entry} is not 0 (Sunday) to 6 (Saturday).`);
      }
      days.add(entry);
      continue;
    }
    const word = entry.trim().toLowerCase();
    if (word === "weekdays") [1, 2, 3, 4, 5].forEach((day) => days.add(day));
    else if (word === "weekends") [0, 6].forEach((day) => days.add(day));
    else {
      const index = WEEKDAY_NAMES.findIndex((name) => word.startsWith(name));
      if (index === -1) return Result.fail(`"${entry}" is not a weekday. Use mon, tue, … sun.`);
      days.add(index);
    }
  }
  return Result.succeed([...days].toSorted((left, right) => left - right));
};

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const HAS_OFFSET = /(z|[+-]\d\d:?\d\d)$/i;

/** The named zone, or null for an unknown name. */
const namedZone = (timeZone: string) => Option.getOrNull(DateTime.zoneMakeNamed(timeZone.trim()));

const serverZone = () => DateTime.zoneMakeLocal();

const pad = (value: number) => String(value).padStart(2, "0");

/** Wall-clock parts of `at` in `zone`. */
const partsIn = (at: DateTime.DateTime, zone: DateTime.TimeZone) =>
  DateTime.toParts(DateTime.setZone(at, zone));

/** The instant a wall-clock time in `zone` names, or null inside a gap the zone skips. */
const wallClock = (
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  zone: DateTime.TimeZone,
) =>
  Option.getOrNull(
    DateTime.makeZoned(
      { ...parts, second: 0, millisecond: 0 },
      { timeZone: zone, adjustForTimeZone: true },
    ),
  );

export interface WhenInput {
  readonly in?: string | undefined;
  readonly at?: string | undefined;
  readonly every?: string | undefined;
  readonly daily?: string | undefined;
  readonly weekdays?: ReadonlyArray<string | number> | undefined;
  readonly timeZone?: string | undefined;
  readonly webhook?: boolean | undefined;
}

export interface ResolvedWhen {
  readonly schedule: ScheduledTaskUpsertSchedule;
  /** Pause the task after its run: `in` and `at`. */
  readonly runOnce: boolean;
  /** The zone a daily time or `at` was given in, kept for display. */
  readonly timeZone: string | undefined;
}

/** Whether `input` names a time at all. */
export const hasWhen = (input: WhenInput) =>
  input.in !== undefined ||
  input.at !== undefined ||
  input.every !== undefined ||
  input.daily !== undefined ||
  input.webhook === true;

/**
 * The upstream schedule for `input`, read at `nowMs`. Exactly one of in, at,
 * every, daily and webhook must be set.
 */
export const resolveWhen = (
  input: WhenInput,
  nowMs: number,
): Result.Result<ResolvedWhen, string> => {
  const given: ReadonlyArray<string> = [
    ...(["in", "at", "every", "daily"] as const).filter((key) => input[key] !== undefined),
    ...(input.webhook === true ? ["webhook"] : []),
  ];
  if (given.length !== 1) {
    return Result.fail(
      given.length === 0
        ? 'Say when: in ("10m"), at (an ISO time or "09:00"), every ("2h"), daily ("09:00") or webhook: true.'
        : `Pass one of in, at, every, daily and webhook, not ${given.join(" and ")}.`,
    );
  }
  if (input.weekdays !== undefined && input.daily === undefined) {
    return Result.fail("weekdays goes with daily.");
  }
  const zone = input.timeZone === undefined ? serverZone() : namedZone(input.timeZone);
  if (zone === null) {
    return Result.fail(
      `"${input.timeZone}" is not a time zone. Use an IANA name such as Asia/Kolkata.`,
    );
  }
  const timeZone = input.timeZone?.trim();

  if (input.webhook === true) {
    return Result.succeed({
      schedule: { type: "webhook", signature: null },
      runOnce: false,
      timeZone: undefined,
    });
  }
  if (input.every !== undefined) {
    const everyMs = parseDuration(input.every);
    if (everyMs === null)
      return Result.fail(`every: "${input.every}" is not a duration like 30m, 2h or 1d.`);
    if (everyMs < MIN_SCHEDULED_TASK_INTERVAL_MS) return Result.fail("every must be at least 1m.");
    return Result.succeed({
      schedule: { type: "interval", everyMs },
      runOnce: false,
      timeZone: undefined,
    });
  }
  if (input.in !== undefined) {
    const delayMs = parseDuration(input.in);
    if (delayMs === null)
      return Result.fail(`in: "${input.in}" is not a duration like 10m, 2h or 1d.`);
    if (delayMs < MIN_SCHEDULED_TASK_INTERVAL_MS) return Result.fail("in must be at least 1m.");
    return Result.succeed({
      schedule: { type: "interval", everyMs: delayMs },
      runOnce: true,
      timeZone: undefined,
    });
  }
  if (input.at !== undefined) {
    const atMs = resolveAt(input.at.trim(), zone, nowMs);
    if (atMs === null) {
      return Result.fail(
        `at: "${input.at}" is not a time. Pass an ISO time (2026-10-12T09:00, with an offset or in timeZone) or "HH:MM" for the next such time.`,
      );
    }
    const delayMs = atMs - nowMs;
    if (delayMs < MIN_SCHEDULED_TASK_INTERVAL_MS) {
      return Result.fail("at must be at least one minute from now.");
    }
    return Result.succeed({
      schedule: { type: "interval", everyMs: delayMs },
      runOnce: true,
      timeZone,
    });
  }

  const daily = input.daily ?? "";
  const time = TIME_OF_DAY.exec(daily.trim());
  if (time === null) return Result.fail(`daily: "${daily}" is not a time like 09:00.`);
  const weekdays =
    input.weekdays === undefined ? Result.succeed([]) : parseWeekdays(input.weekdays);
  if (Result.isFailure(weekdays)) return Result.fail(weekdays.failure);
  const converted = toServerTime(
    { hour: Number(time[1]), minute: Number(time[2]) },
    weekdays.success,
    zone,
    nowMs,
  );
  if (converted === null)
    return Result.fail(`daily: ${daily} does not exist in ${timeZone} today.`);
  return Result.succeed({
    schedule: {
      type: "fixed_time",
      timeOfDay: converted.timeOfDay,
      ...(converted.weekdays.length === 0 ? {} : { weekdays: converted.weekdays }),
    },
    runOnce: false,
    timeZone,
  });
};

/** An ISO time (its offset, else wall clock in `zone`) or "HH:MM" next in `zone`, as epoch ms. */
const resolveAt = (text: string, zone: DateTime.TimeZone, nowMs: number): number | null => {
  const time = TIME_OF_DAY.exec(text);
  if (time !== null) {
    const today = partsIn(DateTime.makeUnsafe(nowMs), zone);
    for (const offsetDays of [0, 1]) {
      const day = DateTime.add(
        DateTime.makeUnsafe({ year: today.year, month: today.month, day: today.day }),
        { days: offsetDays },
      );
      const parts = DateTime.toPartsUtc(day);
      const candidate = wallClock(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: Number(time[1]),
          minute: Number(time[2]),
        },
        zone,
      );
      if (candidate !== null && DateTime.toEpochMillis(candidate) > nowMs) {
        return DateTime.toEpochMillis(candidate);
      }
    }
    return null;
  }
  if (HAS_OFFSET.test(text)) {
    return Option.match(DateTime.make(text), {
      onNone: () => null,
      onSome: DateTime.toEpochMillis,
    });
  }
  const iso = /^(\d{4})-(\d\d)-(\d\d)(?:[t ](\d\d):(\d\d))?$/i.exec(text);
  if (iso === null) return null;
  const at = wallClock(
    {
      year: Number(iso[1]),
      month: Number(iso[2]),
      day: Number(iso[3]),
      hour: Number(iso[4] ?? 9),
      minute: Number(iso[5] ?? 0),
    },
    zone,
  );
  return at === null ? null : DateTime.toEpochMillis(at);
};

/**
 * A wall-clock time and weekdays in `zone`, as the server-time `fixed_time`
 * upstream stores. The offset is today's, so a zone that changes its clocks
 * shifts by an hour across the change.
 */
const toServerTime = (
  time: { readonly hour: number; readonly minute: number },
  weekdays: ReadonlyArray<number>,
  zone: DateTime.TimeZone,
  nowMs: number,
) => {
  const today = partsIn(DateTime.makeUnsafe(nowMs), zone);
  const instant = wallClock(
    { year: today.year, month: today.month, day: today.day, ...time },
    zone,
  );
  if (instant === null) return null;
  const local = DateTime.toParts(instant);
  const server = partsIn(instant, serverZone());
  // -1, 0 or +1: the server's date is the zone's date shifted by at most a day.
  const shift = ((server.weekDay - local.weekDay + 10) % 7) - 3;
  return {
    timeOfDay: `${pad(server.hour)}:${pad(server.minute)}`,
    weekdays: weekdays.map((day) => (day + shift + 7) % 7).toSorted((left, right) => left - right),
  };
};

/** A time as people read it: "Mon 12 Oct 09:00 UTC", plus the task's zone when it has one. */
export const formatInstant = (iso: string, timeZone: string | undefined): string => {
  const at = DateTime.makeUnsafe(iso);
  const render = (zone: DateTime.TimeZone, label: string) => {
    const parts = partsIn(at, zone);
    const weekday = WEEKDAY_NAMES[parts.weekDay] ?? "";
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${parts.day} ${MONTHS[parts.month - 1]} ${pad(parts.hour)}:${pad(parts.minute)} ${label}`;
  };
  const server = render(serverZone(), serverZoneLabel());
  const zone = timeZone === undefined ? null : namedZone(timeZone);
  return zone === null || timeZone === serverZoneLabel()
    ? server
    : `${server} (${render(zone, timeZone ?? "")})`;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const serverZoneLabel = () => {
  const id = DateTime.zoneToString(serverZone());
  return id === "Etc/UTC" || id === "UTC" ? "UTC" : id;
};

/** How a schedule reads: "every 2h", "once", "daily 09:00 UTC on Mon, Fri", "on each webhook request". */
export const describeSchedule = (
  schedule: ScheduledTaskSchedule,
  options: {
    readonly runOnce?: boolean | undefined;
    readonly timeZone?: string | undefined;
    readonly nowMs: number;
  },
): string => {
  if (schedule.type === "webhook") return "on each request to its webhook URL";
  if (schedule.type === "interval") {
    return options.runOnce === true ? "once" : `every ${formatDuration(schedule.everyMs)}`;
  }
  const days =
    schedule.weekdays === undefined || schedule.weekdays.length === 0
      ? ""
      : ` on ${schedule.weekdays.map((day) => WEEKDAY_NAMES[day]).join(", ")}`;
  const zone = options.timeZone === undefined ? null : namedZone(options.timeZone);
  const server = `daily ${schedule.timeOfDay} ${serverZoneLabel()}${days}`;
  const time = TIME_OF_DAY.exec(schedule.timeOfDay);
  if (zone === null || time === null || options.timeZone === serverZoneLabel()) return server;
  // The zone's time today; a zone that changes its clocks shifts across the change.
  const today = partsIn(DateTime.makeUnsafe(options.nowMs), serverZone());
  const instant = wallClock(
    {
      year: today.year,
      month: today.month,
      day: today.day,
      hour: Number(time[1]),
      minute: Number(time[2]),
    },
    serverZone(),
  );
  if (instant === null) return server;
  const there = partsIn(instant, zone);
  return `${server} (${pad(there.hour)}:${pad(there.minute)} ${options.timeZone})`;
};
