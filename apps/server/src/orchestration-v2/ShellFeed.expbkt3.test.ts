import { describe, expect, it } from "@effect/vitest";
import type { ApplicationStoredEvent, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  makeShellEventFilter,
  makeShellFeed,
  makeShellFeedCore,
  type ShellFeedBatch,
  ShellFeedError,
  type ShellFeedEvent,
  type ShellFeedReads,
  tapShellFeed,
  toShellFeedEvent,
} from "./ShellFeed.expbkt3.ts";

const project = ProjectId.make("project-a");
const owner = UserId.make("user:owner");
const member = UserId.make("user:member");
const stranger = UserId.make("user:stranger");

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: ThreadId.make(id),
  projectId: project,
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 1,
  visibleItemCount: 1,
  branch: null,
  status: "running",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: null,
  latestUserMessageAt: null,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ownerUserId: owner,
  memberUserIds: [member],
  ...overrides,
});

const threadEvent = (sequence: number, threadId: string, type = "run.updated"): ShellFeedEvent => ({
  aggregate: "thread",
  sequence,
  threadId: ThreadId.make(threadId),
  type,
});

const textDelta = (
  sequence: number,
  threadId: string,
  status = "running",
  itemType = "assistant_message",
): ShellFeedEvent => ({
  aggregate: "thread",
  sequence,
  threadId: ThreadId.make(threadId),
  type: "turn-item.updated",
  turnItem: { id: `item:${threadId}`, type: itemType, status, runId: "run-1" },
});

/** Reads that record every batched call and answer from a mutable shell table. */
const countingReads = (shells: Map<ThreadId, OrchestrationV2ThreadShell>) => {
  const calls: Array<ReadonlyArray<ThreadId>> = [];
  const reads: ShellFeedReads = {
    readThreadShells: (threadIds) =>
      Effect.sync(() => {
        calls.push(threadIds);
        return new Map(
          threadIds.flatMap((id) => {
            const value = shells.get(id);
            return value === undefined ? [] : [[id, value] as const];
          }),
        );
      }),
    getProject: () => Effect.succeed(Option.none()),
  };
  return { calls, reads };
};

describe("makeShellEventFilter", () => {
  it("keeps the first sighting and status changes but drops pure text growth", () => {
    const relevant = makeShellEventFilter();
    expect(relevant(textDelta(1, "a"))).toBe(true);
    expect(relevant(textDelta(2, "a"))).toBe(false);
    expect(relevant(textDelta(3, "a"))).toBe(false);
    expect(relevant(textDelta(4, "a", "completed"))).toBe(true);
    expect(relevant(textDelta(5, "a", "completed"))).toBe(false);
    // Execution items reach the shell's pending work, so every update is kept.
    expect(relevant(textDelta(6, "b", "running", "command_execution"))).toBe(true);
    expect(relevant(textDelta(7, "b", "running", "command_execution"))).toBe(true);
    expect(relevant(threadEvent(8, "a", "node.updated"))).toBe(false);
    expect(relevant(threadEvent(9, "a", "provider-turn.updated"))).toBe(false);
    expect(relevant(threadEvent(10, "a", "run.updated"))).toBe(true);
  });

  it("keeps an item again after it falls out of the bounded memory", () => {
    const relevant = makeShellEventFilter(1);
    expect(relevant(textDelta(1, "a"))).toBe(true);
    expect(relevant(textDelta(2, "b"))).toBe(true);
    expect(relevant(textDelta(3, "a"))).toBe(true);
  });
});

describe("makeShellFeedCore", () => {
  it.effect("text-only turn-item updates cause no shell read but still report the sequence", () =>
    Effect.gen(function* () {
      const shells = new Map([[ThreadId.make("a"), shell("a")]]);
      const { calls, reads } = countingReads(shells);
      const core = makeShellFeedCore({ reads, access: [], projects: [], coveredFromSequence: 0 });

      yield* core.process([textDelta(1, "a")]);
      expect(calls).toHaveLength(1);

      const textOnly = yield* core.process([
        textDelta(2, "a"),
        threadEvent(3, "a", "node.updated"),
        textDelta(4, "a"),
        threadEvent(5, "a", "provider-turn.updated"),
      ]);
      expect(calls).toHaveLength(1);
      expect(textOnly).toEqual({ highSequence: 5, entries: [] });

      const completed = yield* core.process([textDelta(6, "a", "completed")]);
      expect(calls).toHaveLength(2);
      expect(completed.entries.map((entry) => entry.sequence)).toEqual([6]);
    }),
  );

  it.effect("reads every touched thread in one call and flags unchanged shells", () =>
    Effect.gen(function* () {
      const shells = new Map([
        [ThreadId.make("a"), shell("a")],
        [ThreadId.make("b"), shell("b")],
      ]);
      const { calls, reads } = countingReads(shells);
      const core = makeShellFeedCore({ reads, access: [], projects: [], coveredFromSequence: 0 });

      const first = yield* core.process([
        threadEvent(1, "a"),
        threadEvent(2, "b"),
        threadEvent(3, "a"),
      ]);
      expect(calls).toEqual([[ThreadId.make("a"), ThreadId.make("b")]]);
      const changes = first.entries.map((entry) => [
        entry.sequence,
        entry.kind === "thread" && entry.changed,
      ]);
      expect(changes).toEqual([
        [2, true],
        [3, true],
      ]);

      // Only updatedAt moved: the feed reports the shell as unchanged.
      shells.set(ThreadId.make("a"), shell("a", { updatedAt: DateTime.makeUnsafe(10) }));
      shells.set(ThreadId.make("b"), shell("b", { title: "Renamed" }));
      const second = yield* core.process([threadEvent(4, "a"), threadEvent(5, "b")]);
      expect(calls).toHaveLength(2);
      expect(second.entries.map((entry) => entry.kind === "thread" && entry.changed)).toEqual([
        false,
        true,
      ]);
    }),
  );

  it.effect("an assistant reply's paired message and turn-item flushes read nothing", () =>
    Effect.gen(function* () {
      const shells = new Map([[ThreadId.make("a"), shell("a")]]);
      const { calls, reads } = countingReads(shells);
      const core = makeShellFeedCore({ reads, access: [], projects: [], coveredFromSequence: 0 });
      // The ACP, Cursor, OpenCode and Pi adapters re-send the message with each text flush.
      const flush = (sequence: number, role: "assistant" | "user", status: string) =>
        [
          {
            sequence,
            commandId: null,
            event: {
              type: "message.updated",
              threadId: ThreadId.make("a"),
              payload: { id: "message-1", role, threadId: ThreadId.make("a") },
            },
          },
          {
            sequence: sequence + 1,
            commandId: null,
            event: {
              type: "turn-item.updated",
              threadId: ThreadId.make("a"),
              payload: { id: "item-1", type: "assistant_message", status, runId: "run-1" },
            },
          },
        ].map((stored) => toShellFeedEvent(stored as unknown as ApplicationStoredEvent));

      // The first sighting may be the item's creation, which moves the item count.
      yield* core.process(flush(1, "assistant", "running"));
      expect(calls).toHaveLength(1);
      for (let sequence = 3; sequence < 43; sequence += 2) {
        const batch = yield* core.process(flush(sequence, "assistant", "running"));
        expect(batch.entries).toEqual([]);
      }
      expect(calls).toHaveLength(1);
      // A user message moves latestUserMessageAt, so it is read.
      yield* core.process(flush(43, "user", "running").slice(0, 1));
      expect(calls).toHaveLength(2);
    }),
  );

  it.effect("knows what a user could see at a cursor, and says when it cannot know", () =>
    Effect.gen(function* () {
      const shared = ThreadId.make("shared");
      const hidden = ThreadId.make("hidden");
      const otherProject = ProjectId.make("project-other");
      const shells = new Map([
        [shared, shell("shared")],
        [hidden, shell("hidden", { ownerUserId: stranger, memberUserIds: [] })],
      ]);
      const { reads } = countingReads(shells);
      const core = makeShellFeedCore({
        reads,
        access: [
          [shared, { projectId: project, ownerUserId: owner, memberUserIds: [member] }],
          [hidden, { projectId: otherProject, ownerUserId: stranger, memberUserIds: [] }],
        ],
        projects: [
          [project, { ownerUserId: owner, memberUserIds: [] }],
          [otherProject, { ownerUserId: stranger, memberUserIds: [] }],
        ],
        coveredFromSequence: 10,
      });
      expect(core.projectHasVisibleThread(project, member)).toBe(true);
      expect(core.projectHasVisibleThread(otherProject, member)).toBe(false);

      shells.set(shared, shell("shared", { memberUserIds: [] }));
      yield* core.process([threadEvent(20, "shared", "thread.metadata-updated")]);
      expect(core.projectHasVisibleThread(project, member)).toBe(false);

      // Before the revocation the member saw the shared thread and, through it, its project.
      const before = core.visibleAt(member, 15);
      expect(before === undefined ? undefined : [...before.threadIds]).toEqual([shared]);
      expect(before === undefined ? undefined : [...before.projectIds]).toEqual([project]);
      const after = core.visibleAt(member, 20);
      expect(after === undefined ? undefined : after.threadIds.size).toBe(0);
      // A stranger's own rows never include another user's thread or project.
      const strangerRows = core.visibleAt(stranger, 15);
      expect(strangerRows === undefined ? undefined : [...strangerRows.threadIds]).toEqual([
        hidden,
      ]);
      // The feed started at 10, so it cannot tell what anyone held before then.
      expect(core.visibleAt(member, 5)).toBeUndefined();
    }),
  );
});

describe("makeShellFeed", () => {
  it.effect("reads each changed thread once per batch whatever the number of subscribers", () =>
    Effect.gen(function* () {
      const shells = new Map([
        [ThreadId.make("a"), shell("a")],
        [ThreadId.make("b"), shell("b")],
      ]);
      const { calls, reads } = countingReads(shells);
      const events = yield* Queue.unbounded<ShellFeedEvent, Cause.Done>();
      const feed = yield* makeShellFeed({
        ...reads,
        latestSequence: Effect.succeed(0),
        loadAccess: Effect.succeed([]),
        loadProjects: Effect.succeed([]),
        events: () => Stream.fromQueue(events),
      });
      const subscriptions = yield* Effect.forEach(Array.from({ length: 8 }), () => feed.subscribe);

      yield* Queue.offerAll(events, [
        threadEvent(1, "a"),
        textDelta(2, "a"),
        textDelta(3, "a"),
        threadEvent(4, "b"),
        textDelta(5, "a"),
      ]);
      // Ending the source flushes the open batch without waiting for its window.
      yield* Queue.end(events);

      const received = yield* Effect.forEach(subscriptions, PubSub.take);
      expect(calls).toEqual([[ThreadId.make("a"), ThreadId.make("b")]]);
      for (const batch of received) {
        expect(batch).toBe(received[0]);
        expect(batch.highSequence).toBe(5);
        // Thread a's later text deltas are dropped, so its entry carries its last kept event.
        expect(batch.entries.map((entry) => entry.sequence)).toEqual([2, 4]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("fails every subscriber when the feed stops", () =>
    Effect.gen(function* () {
      const { reads } = countingReads(new Map());
      const events = yield* Queue.unbounded<ShellFeedEvent, Cause.Done>();
      const feed = yield* makeShellFeed({
        ...reads,
        latestSequence: Effect.succeed(0),
        loadAccess: Effect.succeed([]),
        loadProjects: Effect.succeed([]),
        events: () => Stream.fromQueue(events),
      });
      yield* Queue.end(events);
      const failure = yield* Effect.flip(feed.failed);
      expect(failure._tag).toBe("ShellFeedError");
    }).pipe(Effect.scoped),
  );
});

describe("tapShellFeed", () => {
  const batchOf = (highSequence: number, ...threadIds: ReadonlyArray<string>): ShellFeedBatch => ({
    highSequence,
    entries: threadIds.map((id, index) => ({
      kind: "thread" as const,
      sequence: highSequence - threadIds.length + index + 1,
      threadId: ThreadId.make(id),
      shell: shell(id),
      changed: index === 0,
    })),
  });

  it.effect("merges undelivered batches to the newest entry per row", () =>
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<ShellFeedBatch>();
      const tap = yield* tapShellFeed({ subscribe: PubSub.subscribe(hub), failed: Effect.never });
      yield* PubSub.publish(hub, batchOf(2, "a", "b"));
      yield* PubSub.publish(hub, batchOf(4, "b", "a"));
      yield* PubSub.publish(hub, { highSequence: 9, entries: [] });
      const merged = yield* tap.take;
      expect(merged.highSequence).toBe(9);
      expect(
        merged.entries.map((entry) => [entry.sequence, entry.kind === "thread" && entry.changed]),
      ).toEqual([
        [3, true],
        // a's newest entry was unchanged, but the client never saw the change at sequence 1.
        [4, true],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "detaches only a subscriber that never drains, before it holds more than the bound",
    () =>
      Effect.gen(function* () {
        const hub = yield* PubSub.unbounded<ShellFeedBatch>();
        const feed = { subscribe: PubSub.subscribe(hub), failed: Effect.never };
        const stalled = yield* tapShellFeed(feed, 3);
        const healthy = yield* tapShellFeed(feed, 3);
        yield* PubSub.publish(hub, batchOf(2, "a", "b"));
        expect((yield* healthy.take).entries).toHaveLength(2);
        expect(yield* stalled.retained).toBeLessThanOrEqual(3);
        // Two more rows push the stalled subscriber one past its bound.
        yield* PubSub.publish(hub, batchOf(4, "c", "d"));
        expect((yield* healthy.take).entries).toHaveLength(2);
        expect((yield* Effect.flip(stalled.stopped))._tag).toBe("ShellFeedError");
        expect(yield* stalled.retained).toBe(0);
        expect((yield* Effect.flip(stalled.take))._tag).toBe("ShellFeedError");
        // The healthy subscriber keeps receiving; the stalled one holds nothing more.
        yield* PubSub.publish(hub, batchOf(5, "e"));
        expect((yield* healthy.take).entries).toHaveLength(1);
        expect(yield* stalled.retained).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("fails when the feed stops", () =>
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<ShellFeedBatch>();
      const tap = yield* tapShellFeed({
        subscribe: PubSub.subscribe(hub),
        failed: Effect.fail(new ShellFeedError({ message: "The shell feed stopped." })),
      });
      expect((yield* Effect.flip(tap.take))._tag).toBe("ShellFeedError");
    }).pipe(Effect.scoped),
  );
});
