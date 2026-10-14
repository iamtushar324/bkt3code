#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalConsole:off globalTimers:off preferSchemaOverJson:off - a one-off operator script over a SQLite copy, outside any Effect runtime.
/**
 * T3-CUSTOM(expbkt3): replay the orchestration V2 event history into PostHog
 * session metrics (TEC-1631).
 *
 * Feeds the same tracker the live server uses
 * (`src/telemetry/sessionActivity/SessionActivityReducer.ts`) with the events
 * of a SQLite COPY of the server state, and writes the resulting PostHog
 * events. It never opens a live state file: make a copy first, for example
 * with `VACUUM INTO` (see AGENTS.md, "Test data").
 *
 *   node apps/server/scripts/analytics-backfill.ts <copy.sqlite> [options]
 *
 *   --dry-run            (default) write JSONL and print counts; send nothing
 *   --out <file.jsonl>   JSONL output path (default analytics-backfill.jsonl)
 *   --send               POST to ${T3CODE_POSTHOG_HOST}/batch/; the key comes
 *                        only from env T3CODE_POSTHOG_KEY
 *   --until <iso>        ignore events after this time; required with --send.
 *                        Set it to the moment the live reactor started, so
 *                        the two never overlap.
 *
 * Events with no user whose email is known are skipped (see toBatchItem).
 *   --report-days <n>    print per-state hours for the last n days (default 7)
 *
 * Events are processed one thread at a time, sorted by `occurredAt`: imported
 * history was appended to the log out of time order, so sequence order alone
 * is not time order. Spans still open at the end are not emitted; the live
 * server owns them. Every event carries `backfill: true` and a stable
 * `$insert_id` and uuid, so a re-run does not duplicate events.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  makeSessionActivityTracker,
  type SessionActivityEmission,
  type SessionActivityEvent,
  toEpochMs,
} from "../src/telemetry/sessionActivity/SessionActivityReducer.ts";

const BATCH_SIZE = 500;
const MAX_SEND_ATTEMPTS = 6;

/** Event types the tracker reads; everything else is skipped in SQL. */
const RELEVANT_EVENT_TYPES = [
  "run.created",
  "run.updated",
  "run-attempt.created",
  "runtime-request.updated",
  "subagent.updated",
  "turn-item.updated",
  "provider-thread.updated",
  "plan.updated",
  "message.updated",
] as const;

interface Options {
  readonly dbPath: string;
  readonly send: boolean;
  readonly outPath: string;
  readonly untilMs: number | undefined;
  readonly reportDays: number;
}

function fail(message: string): never {
  console.error(`analytics-backfill: ${message}`);
  process.exit(1);
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  let dbPath: string | undefined;
  let send = false;
  let outPath = "analytics-backfill.jsonl";
  let untilMs: number | undefined;
  let reportDays = 7;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index] ?? fail(`${arg} needs a value`);
    switch (arg) {
      case "--dry-run":
        send = false;
        break;
      case "--send":
        send = true;
        break;
      case "--out":
        outPath = next();
        break;
      case "--until":
        untilMs = toEpochMs(next()) ?? fail("--until must be an ISO time");
        break;
      case "--report-days":
        reportDays = Number(next());
        break;
      default:
        if (arg === undefined || arg.startsWith("--")) fail(`unknown option ${arg}`);
        dbPath = arg;
    }
  }
  if (dbPath === undefined) fail("pass the path of a SQLite COPY of the state database");
  return { dbPath, send, outPath, untilMs, reportDays };
}

/** Refuses any state file under a T3 home `userdata` directory: those are live. */
function assertNotLiveState(dbPath: string): string {
  const resolved = NodeFS.realpathSync(dbPath);
  const t3Home = NodePath.join(NodeOS.homedir(), ".t3");
  const relative = NodePath.relative(t3Home, resolved);
  const insideT3Home = !relative.startsWith("..") && !NodePath.isAbsolute(relative);
  if (insideT3Home && relative.split(NodePath.sep).includes("userdata")) {
    fail(`${resolved} is a live T3 state file. Copy it with VACUUM INTO and pass the copy.`);
  }
  return resolved;
}

type Rec = Record<string, unknown>;

/** Free-text payload fields dropped as soon as a row is read. */
const TEXT_KEYS = [
  "prompt",
  "result",
  "progress",
  "title",
  "text",
  "attachments",
  "context",
  "markdown",
  "steps",
  "explanation",
  "answers",
] as const;

function asRec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/**
 * Keeps only the payload fields the tracker reads, so a thread's history fits
 * in memory and no prompt, output or message text is held longer than a row.
 */
function slimPayload(type: string, payload: Rec): Rec {
  switch (type) {
    case "turn-item.updated":
      return {
        id: payload.id,
        type: payload.type,
        status: payload.status,
        runId: payload.runId ?? null,
        ...(asRec(payload.input)?.persistent === true ? { input: { persistent: true } } : {}),
        ...(asRec(payload.failure) === undefined
          ? {}
          : { failure: { class: asRec(payload.failure)?.class } }),
      };
    case "subagent.updated":
    case "message.updated":
    case "plan.updated": {
      const rest: Rec = { ...payload };
      for (const key of TEXT_KEYS) delete rest[key];
      return rest;
    }
    default:
      if (type.startsWith("thread.")) {
        // The slim analysis copy replaced these with booleans; restore a marker.
        const marked: Rec = { ...payload };
        if (payload.hasMattermostThread === true) marked.mattermostThreadUrl = "present";
        if (payload.hasLinearLink === true) marked.linearIssueUrl = "present";
        delete marked.title;
        delete marked.branch;
        delete marked.worktreePath;
        return marked;
      }
      return payload;
  }
}

interface EventRow {
  readonly sequence: number;
  readonly stream_id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
  readonly metadata_json: string;
}

interface QueuedEvent {
  readonly sequence: number;
  readonly atMs: number;
  readonly event: SessionActivityEvent;
}

function toEvent(row: EventRow): QueuedEvent | undefined {
  const atMs = toEpochMs(row.occurred_at);
  if (atMs === undefined) return undefined;
  const payload = asRec(JSON.parse(row.payload_json));
  const metadata = asRec(JSON.parse(row.metadata_json)) ?? {};
  if (payload === undefined) return undefined;
  const text = (key: string) =>
    typeof metadata[key] === "string" ? (metadata[key] as string) : undefined;
  const runId = text("runId");
  const actorUserId = text("actorUserId");
  const driver = text("driver");
  return {
    sequence: row.sequence,
    atMs,
    event: {
      type: row.event_type,
      threadId: row.stream_id,
      occurredAt: row.occurred_at,
      payload: slimPayload(row.event_type, payload),
      ...(runId === undefined ? {} : { runId }),
      ...(actorUserId === undefined ? {} : { actorUserId }),
      ...(driver === undefined ? {} : { driver }),
    },
  };
}

/** Same derivation as `analyticsIdentity.uuidFromSha256Hex`, so live and backfill ids agree. */
function uuidFromInsertId(insertId: string): string {
  const hex = NodeCrypto.createHash("sha256").update(insertId).digest("hex").padEnd(32, "0");
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function loadUserEmails(db: NodeSqlite.DatabaseSync): Map<string, string> {
  const emails = new Map<string, string>();
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'environment_users'")
    .get();
  if (table === undefined) return emails;
  for (const row of db
    .prepare("SELECT user_id, primary_email FROM environment_users")
    .all() as Array<{ user_id: string; primary_email: string | null }>) {
    // Same normalisation as analyticsIdentity.ts, so live and backfill name one person.
    const email = row.primary_email?.trim().toLowerCase() ?? "";
    if (email !== "") emails.set(row.user_id, email);
  }
  return emails;
}

interface BatchItem {
  readonly uuid: string;
  readonly event: string;
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly properties: Rec;
}

/**
 * The PostHog item for an emission, or undefined when no person is known.
 *
 * Live sends an unattributed event under the server install's anonymous id,
 * which comes from that machine's T3 home, not from the database, so a copy
 * cannot reproduce it. Inventing another id would create a fake person, so
 * the backfill skips these events instead. Nearly every session has an owner,
 * so very little is lost. `--until` keeps the backfill and live from covering
 * the same time, so this cannot break live/backfill de-duplication; re-runs of
 * the backfill stay de-duplicated by the stable uuid.
 */
function toBatchItem(
  emission: SessionActivityEmission,
  emails: ReadonlyMap<string, string>,
  instance: string,
): BatchItem | undefined {
  const email = emission.userId === undefined ? undefined : emails.get(emission.userId);
  if (email === undefined) return undefined;
  return {
    uuid: uuidFromInsertId(emission.insertId),
    event: emission.event,
    distinct_id: email,
    timestamp: emission.timestamp,
    properties: {
      ...emission.properties,
      backfill: true,
      $insert_id: emission.insertId,
      $process_person_profile: true,
      $groups: { instance },
      instance,
    },
  };
}

async function sendBatch(host: string, apiKey: string, batch: ReadonlyArray<BatchItem>) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(`${host}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, historical_migration: true, batch }),
      });
      if (response.ok) return;
      if (response.status < 500 && response.status !== 429) {
        fail(`PostHog rejected a batch with HTTP ${response.status}`);
      }
      throw new Error(`HTTP ${response.status}`);
    } catch (cause) {
      if (attempt >= MAX_SEND_ATTEMPTS)
        fail(`batch failed after ${attempt} attempts: ${String(cause)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = assertNotLiveState(options.dbPath);
  const host = process.env.T3CODE_POSTHOG_HOST ?? "https://us.i.posthog.com";
  const apiKey = process.env.T3CODE_POSTHOG_KEY ?? "";
  const instance = process.env.T3CODE_ANALYTICS_INSTANCE ?? "unknown";
  if (options.send && apiKey.trim() === "") fail("--send needs env T3CODE_POSTHOG_KEY");
  if (options.send && options.untilMs === undefined) {
    fail(
      "--send needs --until <iso>: the time the live reactor started. Without it the backfill " +
        "and the live server can both report the same time.",
    );
  }

  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  const emails = loadUserEmails(db);
  const tracker = makeSessionActivityTracker({ backfill: true });

  const out = options.send ? undefined : NodeFS.openSync(options.outPath, "w");
  const counts = new Map<string, number>();
  const stateHours = new Map<string, number>();
  const newest = db
    .prepare("SELECT occurred_at FROM orchestration_events ORDER BY sequence DESC LIMIT 1")
    .get() as { occurred_at: string } | undefined;
  const reportEndMs = options.untilMs ?? toEpochMs(newest?.occurred_at) ?? 0;
  const reportFromMs = reportEndMs - options.reportDays * 86_400_000;
  let latestMs = 0;
  let pending: Array<BatchItem> = [];
  let sent = 0;
  let unattributed = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (options.send) {
      await sendBatch(host, apiKey, batch);
      sent += batch.length;
    } else if (out !== undefined) {
      NodeFS.writeSync(out, batch.map((item) => JSON.stringify(item)).join("\n") + "\n");
    }
  };

  const collect = async (emissions: ReadonlyArray<SessionActivityEmission>) => {
    for (const emission of emissions) {
      counts.set(emission.event, (counts.get(emission.event) ?? 0) + 1);
      if (emission.event === "session.state.span") {
        const endedMs = toEpochMs(emission.timestamp) ?? 0;
        if (endedMs >= reportFromMs) {
          const state = String(emission.properties.state);
          const hours = Number(emission.properties.durationMs) / 3_600_000;
          stateHours.set(state, (stateHours.get(state) ?? 0) + hours);
        }
      }
      const item = toBatchItem(emission, emails, instance);
      if (item === undefined) {
        unattributed += 1;
        continue;
      }
      pending.push(item);
      if (pending.length >= BATCH_SIZE) await flush();
    }
  };

  const placeholders = RELEVANT_EVENT_TYPES.map(() => "?").join(", ");
  // Uses idx_orch_events_stream_sequence (aggregate_kind, stream_id, sequence).
  const rows = db
    .prepare(
      `SELECT sequence, stream_id, event_type, occurred_at, payload_json, metadata_json
         FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND application_event_version = 2
          AND (event_type LIKE 'thread.%' OR event_type IN (${placeholders}))
        ORDER BY aggregate_kind, stream_id, sequence`,
    )
    .iterate(...RELEVANT_EVENT_TYPES) as Iterable<EventRow>;

  let threadId: string | undefined;
  let threadEvents: Array<QueuedEvent> = [];
  let threads = 0;
  const replayThread = async () => {
    threadEvents.sort((a, b) => a.atMs - b.atMs || a.sequence - b.sequence);
    for (const queued of threadEvents) {
      if (options.untilMs !== undefined && queued.atMs > options.untilMs) break;
      latestMs = Math.max(latestMs, queued.atMs);
      await collect(tracker.apply(queued.event));
    }
    threadEvents = [];
    threads += 1;
  };

  for (const row of rows) {
    if (row.stream_id !== threadId) {
      if (threadId !== undefined) await replayThread();
      threadId = row.stream_id;
    }
    const queued = toEvent(row);
    if (queued !== undefined) threadEvents.push(queued);
  }
  if (threadId !== undefined) await replayThread();
  await flush();
  if (out !== undefined) NodeFS.closeSync(out);
  db.close();

  console.log(`threads replayed: ${threads}`);
  console.log(`latest event: ${latestMs > 0 ? new Date(latestMs).toISOString() : "none"}`);
  console.log(options.send ? `sent: ${sent} events` : `wrote: ${options.outPath}`);
  console.log(`skipped, no known user email: ${unattributed}`);
  console.log("events by type:");
  for (const [event, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${event}: ${count}`);
  }
  console.log(`state hours, last ${options.reportDays} days (by span end):`);
  for (const [state, hours] of [...stateHours].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${state}: ${hours.toFixed(1)}`);
  }
}

await main();
