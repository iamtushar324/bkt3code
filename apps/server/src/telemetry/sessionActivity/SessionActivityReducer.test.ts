// T3-CUSTOM(expbkt3): session time-in-state metrics (TEC-1631).
// Fixtures follow real `orchestration_events` rows from bkt3 (ids shortened;
// every text field replaced by a SECRET_* sentinel the privacy test looks for).
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  makeSessionActivityTracker,
  SESSION_ACTIVITY_PROPERTY_KEYS,
  type SessionActivityEmission,
  type SessionActivityEvent,
} from "./SessionActivityReducer.ts";

const THREAD = "d8658052-d2d8-4141-bc61-d91bfc5c570b";
const OWNER = "user_owner";
const SENDER = "user_sender";
const RUN = `run:thread:${THREAD}:ordinal:73`;

const at = (time: string) => `2026-10-09T${time}Z`;
const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

function threadPayload(overrides: Record<string, unknown> = {}) {
  return {
    ownerUserId: OWNER,
    memberUserIds: [OWNER],
    parentThreadId: null,
    createdBy: "user",
    creationSource: "web",
    id: THREAD,
    projectId: "project-1",
    title: "SECRET_TITLE",
    providerInstanceId: "claudeAgent",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "SECRET_BRANCH",
    worktreePath: "/SECRET_PATH",
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
    forkedFrom: null,
    createdAt: at("09:00:00.000"),
    updatedAt: at("09:00:00.000"),
    archivedAt: null,
    snoozedUntil: null,
    deletedAt: null,
    ...overrides,
  };
}

function event(
  type: string,
  occurredAt: string,
  payload: unknown,
  extra: Partial<SessionActivityEvent> = {},
): SessionActivityEvent {
  return { type, threadId: THREAD, occurredAt, payload, ...extra };
}

function runPayload(status: string, fields: Record<string, unknown> = {}) {
  return {
    id: RUN,
    threadId: THREAD,
    ordinal: 73,
    providerInstanceId: "claudeAgent",
    modelSelection: {
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: false },
      ],
    },
    userMessageId: "message-1",
    status,
    requestedAt: at("09:06:19.278"),
    startedAt: null,
    completedAt: null,
    ...fields,
  };
}

function userMessage(fields: Record<string, unknown> = {}) {
  return {
    sentByUserId: SENDER,
    createdBy: "user",
    creationSource: "web",
    id: "message-1",
    threadId: THREAD,
    runId: null,
    role: "user",
    text: "SECRET_PROMPT",
    attachments: [],
    streaming: false,
    createdAt: at("09:06:19.000"),
    updatedAt: at("09:06:19.000"),
    ...fields,
  };
}

function questionPayload(status: string, resolvedAt: string | null) {
  return {
    id: "runtime-request:native-request:toolu_01",
    nodeId: "node:runtime-request:toolu_01",
    kind: "user_input",
    status,
    responseCapability: { type: "live", providerSessionId: "provider-session:1" },
    createdAt: at("09:07:25.279"),
    resolvedAt,
    ...(status === "resolved" ? { answers: { q1: "SECRET_ANSWER" } } : {}),
  };
}

function subagentPayload(status: string, fields: Record<string, unknown> = {}) {
  return {
    id: "node:subagent:task-1",
    threadId: THREAD,
    runId: RUN,
    parentNodeId: "node:root",
    origin: "provider_native",
    createdBy: "agent",
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: "thread:provider:claudeAgent:native-thread:child",
    prompt: "SECRET_SUBAGENT_PROMPT",
    title: "SECRET_SUBAGENT_TITLE",
    result: status === "completed" ? "SECRET_RESULT" : null,
    status,
    startedAt: at("09:08:00.000"),
    completedAt: status === "completed" ? at("09:20:00.000") : null,
    updatedAt: at("09:08:00.000"),
    ...fields,
  };
}

function feed(events: ReadonlyArray<SessionActivityEvent>, backfill = false) {
  const tracker = makeSessionActivityTracker({ backfill });
  const out: Array<SessionActivityEmission> = [];
  for (const item of events) out.push(...tracker.apply(item));
  return { tracker, out };
}

const spans = (out: ReadonlyArray<SessionActivityEmission>) =>
  out.filter((emission) => emission.event === "session.state.span");

/** [state, waitKind, durationMs, endReason] per span. */
const spanSummary = (out: ReadonlyArray<SessionActivityEmission>) =>
  spans(out).map((span) => [
    span.properties.state,
    span.properties.waitKind,
    span.properties.durationMs,
    span.properties.endReason,
  ]);

const startedRun = (time: string) => runPayload("running", { startedAt: at(time) });
const archivedThread = (time: string) => threadPayload({ archivedAt: at(time) });

const created = event("thread.created", at("09:00:00.000"), threadPayload());

describe("SessionActivityReducer", () => {
  it("counts a question asked mid-run as human wait, not agent time", () => {
    const { out } = feed([
      created,
      event("message.updated", at("09:06:19.000"), userMessage()),
      event("run.created", at("09:06:19.278"), runPayload("starting"), { actorUserId: SENDER }),
      event("run-attempt.created", at("09:06:19.278"), { id: "attempt-1", runId: RUN }),
      event(
        "run.updated",
        at("09:06:19.534"),
        runPayload("running", { startedAt: at("09:06:19.534") }),
        { driver: "claudeAgent" },
      ),
      event("runtime-request.updated", at("09:07:25.320"), questionPayload("pending", null), {
        runId: RUN,
      }),
      event(
        "runtime-request.updated",
        at("09:09:23.778"),
        questionPayload("resolved", at("09:09:23.778")),
        { runId: RUN, actorUserId: SENDER },
      ),
      event(
        "run.updated",
        at("09:10:09.686"),
        runPayload("waiting", { startedAt: at("09:06:19.534") }),
      ),
      event(
        "run.updated",
        at("09:10:09.747"),
        runPayload("completed", {
          startedAt: at("09:06:19.534"),
          completedAt: at("09:10:09.747"),
        }),
      ),
      event("thread.visited", at("09:30:00.000"), threadPayload()),
    ]);

    assert.deepStrictEqual(spanSummary(out), [
      ["idle", undefined, 379_278, "agent_running"],
      ["agent_running", undefined, 66_042, "waiting_human"],
      ["waiting_human", "question", 118_458, "agent_running"],
      ["agent_running", undefined, 45_908, "idle"],
    ]);
    const waitSpan = spans(out)[2];
    assert.strictEqual(waitSpan?.properties.runId, RUN);
    assert.strictEqual(waitSpan?.properties.senderUserId, SENDER);
    assert.strictEqual(waitSpan?.userId, OWNER);

    const resolved = out.find((emission) => emission.event === "human_request.resolved");
    assert.strictEqual(resolved?.properties.waitMs, 118_499);
    assert.strictEqual(resolved?.properties.resolution, "answered");
    assert.strictEqual(resolved?.properties.answeredByUserId, SENDER);

    const finished = out.find((emission) => emission.event === "run.finished");
    assert.deepStrictEqual(
      {
        status: finished?.properties.status,
        queueWaitMs: finished?.properties.queueWaitMs,
        runDurationMs: finished?.properties.runDurationMs,
        attempts: finished?.properties.attempts,
        effort: finished?.properties.effort,
        runTrigger: finished?.properties.runTrigger,
        senderUserId: finished?.properties.senderUserId,
      },
      {
        status: "completed",
        queueWaitMs: 256,
        runDurationMs: 230_213,
        attempts: 1,
        effort: "high",
        runTrigger: "human",
        senderUserId: SENDER,
      },
    );
  });

  it("waits on workers after the run ends while a subagent still runs", () => {
    const { out } = feed([
      created,
      event("run.created", at("09:06:19.278"), startedRun("09:06:19.278")),
      event("subagent.updated", at("09:08:00.000"), subagentPayload("running")),
      event(
        "run.updated",
        at("09:10:00.000"),
        runPayload("completed", {
          startedAt: at("09:06:19.278"),
          completedAt: at("09:10:00.000"),
        }),
      ),
      event("subagent.updated", at("09:20:00.000"), subagentPayload("completed")),
      event("thread.visited", at("09:25:00.000"), threadPayload()),
    ]);

    const summary = spanSummary(out);
    assert.deepStrictEqual(summary.slice(1), [
      ["agent_running", undefined, 220_722, "waiting_workers"],
      ["waiting_workers", undefined, 600_000, "idle"],
    ]);
    const workerSpan = spans(out)[2];
    assert.strictEqual(workerSpan?.properties.activeWorkers, 0);
    assert.strictEqual(workerSpan?.properties.maxActiveWorkers, 1);

    const finished = out.find((emission) => emission.event === "subagent.finished");
    assert.strictEqual(finished?.properties.durationMs, 720_000);
    assert.strictEqual(finished?.properties.childThreadPresent, true);
    assert.strictEqual(finished?.properties.origin, "provider_native");
  });

  it("measures queued, running and idle time in order", () => {
    const { out } = feed([
      created,
      event(
        "run.created",
        at("09:01:00.000"),
        runPayload("queued", { requestedAt: at("09:01:00.000") }),
      ),
      event(
        "run.updated",
        at("09:03:00.000"),
        runPayload("running", { requestedAt: at("09:01:00.000"), startedAt: at("09:03:00.000") }),
      ),
      event(
        "run.updated",
        at("09:08:00.000"),
        runPayload("failed", {
          requestedAt: at("09:01:00.000"),
          startedAt: at("09:03:00.000"),
          completedAt: at("09:08:00.000"),
        }),
      ),
      event("thread.visited", at("09:10:00.000"), threadPayload()),
    ]);
    assert.deepStrictEqual(
      spanSummary(out).map(([state, , durationMs]) => [state, durationMs]),
      [
        ["idle", 60_000],
        ["queued", 120_000],
        ["agent_running", 300_000],
      ],
    );
    const finished = out.find((emission) => emission.event === "run.finished");
    assert.strictEqual(finished?.properties.queueWaitMs, 120_000);
    assert.strictEqual(finished?.properties.failureClass, "unknown");
  });

  it("tracks archive and unarchive as a terminal state with lifecycle events", () => {
    const { out } = feed([
      created,
      event("thread.archived", at("10:00:00.000"), archivedThread("10:00:00.000")),
      event("thread.unarchived", at("12:00:00.000"), threadPayload({ archivedAt: null })),
      event("thread.visited", at("12:30:00.000"), threadPayload()),
    ]);
    assert.deepStrictEqual(
      spanSummary(out).map(([state, , durationMs, endReason]) => [state, durationMs, endReason]),
      [
        ["idle", 3_600_000, "archived"],
        ["archived", 7_200_000, "idle"],
      ],
    );
    const archived = out.find((emission) => emission.event === "session.archived");
    assert.strictEqual(archived?.properties.ageMs, 3_600_000);
    assert.ok(out.some((emission) => emission.event === "session.unarchived"));
  });

  it("waits on a proposed plan until the next run decides it", () => {
    const { out } = feed([
      created,
      event("run.created", at("09:01:00.000"), startedRun("09:01:00.000")),
      event("plan.updated", at("09:04:00.000"), {
        id: "plan-1",
        threadId: THREAD,
        runId: RUN,
        nodeId: "node:plan",
        status: "active",
        kind: "proposed_plan",
        markdown: "SECRET_PLAN",
      }),
      event(
        "run.updated",
        at("09:05:00.000"),
        runPayload("completed", { startedAt: at("09:01:00.000"), completedAt: at("09:05:00.000") }),
      ),
      event(
        "run.created",
        at("09:15:00.000"),
        runPayload("running", {
          id: "run-2",
          ordinal: 74,
          startedAt: at("09:15:00.000"),
          sourcePlanRef: { threadId: THREAD, planId: "plan-1" },
        }),
      ),
    ]);
    const planSpan = spans(out).find((span) => span.properties.waitKind === "plan");
    assert.strictEqual(planSpan?.properties.durationMs, 600_000);
    const decided = out.find((emission) => emission.event === "plan.decided");
    assert.strictEqual(decided?.properties.decision, "implemented");
    assert.strictEqual(decided?.properties.waitMs, 600_000);
  });

  it("splits a span at UTC midnight", () => {
    const tracker = makeSessionActivityTracker({ backfill: false });
    tracker.apply(event("thread.created", "2026-10-09T22:00:00.000Z", threadPayload()));
    const out = tracker.apply(
      event("thread.archived", "2026-10-10T03:00:00.000Z", threadPayload()),
    );
    assert.deepStrictEqual(
      spans(out).map((span) => [
        span.properties.durationMs,
        span.properties.segmentIndex,
        span.properties.endReason,
      ]),
      [
        [7_200_000, 0, "idle"],
        [10_800_000, 1, "archived"],
      ],
    );
    assert.notStrictEqual(spans(out)[0]?.insertId, spans(out)[1]?.insertId);
  });

  it("ignores provider-native subagent transcript threads", () => {
    const tracker = makeSessionActivityTracker({ backfill: false });
    const child = "thread:provider:claudeAgent:native-thread:child";
    const out = tracker.apply({
      type: "thread.created",
      threadId: child,
      occurredAt: at("09:00:00.000"),
      payload: threadPayload({
        id: child,
        createdBy: "agent",
        creationSource: "provider",
        lineage: { parentThreadId: THREAD, relationshipToParent: "subagent", rootThreadId: THREAD },
      }),
    });
    assert.deepStrictEqual(out, []);
    assert.deepStrictEqual(tracker.snapshot(epoch(at("10:00:00.000"))).length, 1);
  });

  it("replays an imported, already finished run from its recorded start", () => {
    const { out } = feed([
      created,
      event(
        "run.created",
        at("09:05:00.000"),
        runPayload("completed", {
          requestedAt: at("09:02:00.000"),
          startedAt: at("09:02:00.000"),
          completedAt: at("09:05:00.000"),
        }),
      ),
      event("thread.visited", at("09:06:00.000"), threadPayload()),
    ]);
    assert.deepStrictEqual(
      spanSummary(out).map(([state, , durationMs]) => [state, durationMs]),
      [
        ["idle", 120_000],
        ["agent_running", 180_000],
      ],
    );
  });

  it("marks seeded spans as resumed and closes them on shutdown", () => {
    const tracker = makeSessionActivityTracker({ backfill: false });
    const bootMs = epoch(at("09:00:00.000"));
    tracker.seed(
      {
        ...threadPayload(),
        activeRunId: RUN,
        activityRunStatus: "running",
        latestRunId: RUN,
        status: "running",
        pendingRuntimeRequest: null,
        activeSubagentCount: 2,
        pendingBackgroundTasks: [],
      },
      bootMs,
    );
    const snapshot = tracker.snapshot(bootMs + 1_000);
    const total = snapshot.find((emission) => emission.properties.scope === "total");
    assert.strictEqual(total?.properties.runningRuns, 1);
    assert.strictEqual(total?.properties.activeSubagents, 2);
    const perUser = snapshot.find((emission) => emission.properties.scope === "user");
    assert.strictEqual(perUser?.userId, OWNER);
    assert.strictEqual(perUser?.properties.count, 1);

    const closed = tracker.closeAll(bootMs + 60_000, "server_stopped");
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0]?.properties.state, "agent_running");
    assert.strictEqual(closed[0]?.properties.resumedAfterRestart, true);
    assert.strictEqual(closed[0]?.properties.endReason, "server_stopped");
    assert.strictEqual(closed[0]?.properties.durationMs, 60_000);
  });

  it("never emits text, paths or unlisted keys", () => {
    const { tracker, out } = feed(
      [
        created,
        event("message.updated", at("09:06:19.000"), userMessage()),
        event("run.created", at("09:06:19.278"), startedRun("09:06:19.278")),
        event("runtime-request.updated", at("09:07:25.320"), questionPayload("pending", null), {
          runId: RUN,
        }),
        event("subagent.updated", at("09:08:00.000"), subagentPayload("running")),
        event(
          "runtime-request.updated",
          at("09:09:23.778"),
          questionPayload("resolved", at("09:09:23.778")),
          { runId: RUN },
        ),
        event("subagent.updated", at("09:20:00.000"), subagentPayload("completed")),
        event("turn-item.updated", at("09:09:30.000"), {
          id: "turn-item:error",
          type: "error",
          status: "completed",
          runId: RUN,
          title: "SECRET_ERROR_TITLE",
          failure: {
            class: "provider_error",
            message: "SECRET_ERROR",
            code: null,
            retryable: null,
          },
        }),
        event(
          "run.updated",
          at("09:21:00.000"),
          runPayload("failed", { startedAt: at("09:06:19.278"), completedAt: at("09:21:00.000") }),
        ),
        event("thread.archived", at("10:00:00.000"), archivedThread("10:00:00.000")),
      ],
      true,
    );
    const all = [
      ...out,
      ...tracker.snapshot(epoch(at("11:00:00.000"))),
      ...tracker.closeAll(epoch(at("12:00:00.000")), "server_stopped"),
    ];
    const allowed = new Set<string>(SESSION_ACTIVITY_PROPERTY_KEYS);
    for (const emission of all) {
      for (const [key, value] of Object.entries(emission.properties)) {
        assert.ok(allowed.has(key), `unlisted key ${key} on ${emission.event}`);
        assert.ok(
          !(typeof value === "string" && (value.includes("SECRET") || value.includes("/"))),
          `${emission.event}.${key} leaks text`,
        );
      }
      assert.strictEqual(emission.properties.backfill, true);
    }
    const finished = all.find((emission) => emission.event === "run.finished");
    assert.strictEqual(finished?.properties.failureClass, "provider_error");
  });
});
