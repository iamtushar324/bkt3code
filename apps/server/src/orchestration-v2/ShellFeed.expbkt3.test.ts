import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
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
  type ShellFeedEvent,
  type ShellFeedReads,
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
      const core = makeShellFeedCore({ reads, access: [], coveredFromSequence: 0 });

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
      const core = makeShellFeedCore({ reads, access: [], coveredFromSequence: 0 });

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

  it.effect("answers project access through threads and a thread's access at a sequence", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("a");
      const shells = new Map([[threadId, shell("a")]]);
      const { reads } = countingReads(shells);
      const core = makeShellFeedCore({
        reads,
        access: [[threadId, { projectId: project, ownerUserId: owner, memberUserIds: [member] }]],
        coveredFromSequence: 10,
      });
      expect(core.projectHasVisibleThread(project, member)).toBe(true);
      expect(core.projectHasVisibleThread(project, stranger)).toBe(false);

      shells.set(threadId, shell("a", { memberUserIds: [] }));
      const revoked = yield* core.process([threadEvent(20, "a", "thread.metadata-updated")]);
      expect(revoked.entries[0]).toMatchObject({
        kind: "thread",
        previousAccess: { ownerUserId: owner, memberUserIds: [member] },
      });
      expect(core.projectHasVisibleThread(project, member)).toBe(false);
      expect(core.accessAt(threadId, 15)).toMatchObject({ memberUserIds: [member] });
      expect(core.accessAt(threadId, 20)).toMatchObject({ memberUserIds: [] });
      // The feed started at 10, so it cannot tell what changed before then.
      expect(core.accessAt(threadId, 5)).toBe("unknown");
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
        events: () => Stream.fromQueue(events),
      });
      yield* Queue.end(events);
      const failure = yield* Effect.flip(feed.failed);
      expect(failure._tag).toBe("ShellFeedError");
    }).pipe(Effect.scoped),
  );
});
