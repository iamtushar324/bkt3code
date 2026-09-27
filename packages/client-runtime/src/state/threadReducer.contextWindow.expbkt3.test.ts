// T3-CUSTOM(expbkt3): the in-order context-window fast path must equal the sorting path.
import { describe, expect, it } from "vite-plus/test";

import {
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { applyThreadDetailEvent } from "./threadReducer.ts";

const threadId = ThreadId.make("thread-1");
const baseThread: OrchestrationThread = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  sourceControlProfileId: null,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  ownerUserId: null,
  memberUserIds: [],
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  rollingSummary: null,
  turnSummaries: [],
  session: null,
};

// Small deterministic PRNG so failures reproduce.
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};

const makeStream = (count: number, seed: number): OrchestrationThreadActivity[] => {
  const next = random(seed);
  return Array.from({ length: count }, (_, index) => {
    const turnId = TurnId.make(`turn-${Math.floor(index / 40)}`);
    const roll = next();
    const contextWindow = roll < 0.25;
    return {
      id: EventId.make(`activity-${index}`),
      tone: "info" as const,
      kind: contextWindow ? "context-window.updated" : "tool.completed",
      summary: `activity ${index}`,
      // A few malformed context-window rows must survive untouched.
      payload: contextWindow ? { usedTokens: roll < 0.02 ? undefined : index } : { index },
      turnId,
      sequence: index + 1,
      createdAt: `2026-04-01T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
    };
  });
};

const appendEvent = (activity: OrchestrationThreadActivity, sequence: number) => ({
  eventId: EventId.make(`event-${sequence}`),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  sequence,
  occurredAt: "2026-04-01T00:01:00.000Z",
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  type: "thread.activity-appended" as const,
  payload: { threadId, activity },
});

/** The documented rule, written out plainly: filter, append, sort. */
const reference = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activity: OrchestrationThreadActivity,
) => {
  const resolvable = (entry: OrchestrationThreadActivity) =>
    entry.kind === "context-window.updated" &&
    typeof (entry.payload as { usedTokens?: unknown }).usedTokens === "number";
  const supersedes = resolvable(activity);
  return [
    ...activities.filter(
      (entry) =>
        entry.id !== activity.id &&
        !(supersedes && entry.turnId === activity.turnId && resolvable(entry)),
    ),
    activity,
  ].sort(
    (left, right) =>
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
};

describe("in-order context-window appends", () => {
  it.each([1, 7, 42])("match filter+append+sort on a random stream (seed %i)", (seed) => {
    const stream = makeStream(600, seed);
    let expected: ReadonlyArray<OrchestrationThreadActivity> = [];
    let current = baseThread;
    stream.forEach((activity, index) => {
      expected = reference(expected, activity);
      const result = applyThreadDetailEvent(current, appendEvent(activity, index + 1));
      if (result.kind === "updated") current = result.thread;
      expect(current.activities.map((entry) => entry.id)).toEqual(
        expected.map((entry) => entry.id),
      );
    });
    // A later out-of-order or redelivered row still takes the sorting path.
    const redelivered = { ...stream[5]!, summary: "redelivered" };
    const result = applyThreadDetailEvent(current, appendEvent(redelivered, 10_000));
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.thread.activities.map((entry) => entry.id)).toEqual(
        reference(current.activities, redelivered).map((entry) => entry.id),
      );
    }
  });
});
