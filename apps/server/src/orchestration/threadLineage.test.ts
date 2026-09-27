// T3-CUSTOM(expbkt3): session lineage invariant coverage.
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { expect as effectExpect, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  collectThreadDescendants,
  requireThreadLineageAcyclic,
  threadLineageWouldCycle,
} from "./threadLineage.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeThread(id: string, parentThreadId: string | null): OrchestrationThread {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    ownerUserId: null,
    memberUserIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    priority: null,
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  } as unknown as OrchestrationThread;
}

// root → child → grandchild, plus an unrelated sibling tree.
const threads = [
  makeThread("root", null),
  makeThread("child", "root"),
  makeThread("grandchild", "child"),
  makeThread("other", null),
];

const readModel = {
  snapshotSequence: 0,
  projects: [],
  threads,
  updatedAt: NOW,
} as unknown as OrchestrationReadModel;

const command = {
  type: "thread.meta.update",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("root"),
} as unknown as OrchestrationCommand;

describe("threadLineageWouldCycle", () => {
  it("rejects a thread parenting itself", () => {
    expect(
      threadLineageWouldCycle({
        threads,
        threadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("root"),
      }),
    ).toBe(true);
  });

  it("rejects adopting a direct child", () => {
    expect(
      threadLineageWouldCycle({
        threads,
        threadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("child"),
      }),
    ).toBe(true);
  });

  it("rejects adopting a deeper descendant", () => {
    expect(
      threadLineageWouldCycle({
        threads,
        threadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("grandchild"),
      }),
    ).toBe(true);
  });

  it("allows moving a subtree under an unrelated thread", () => {
    expect(
      threadLineageWouldCycle({
        threads,
        threadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("other"),
      }),
    ).toBe(false);
  });

  it("allows a child to re-parent onto a thread outside its own subtree", () => {
    expect(
      threadLineageWouldCycle({
        threads,
        threadId: ThreadId.make("child"),
        parentThreadId: ThreadId.make("other"),
      }),
    ).toBe(false);
  });

  it("reports a pre-existing cycle instead of walking forever", () => {
    const corrupt = [makeThread("a", "b"), makeThread("b", "a")];
    expect(
      threadLineageWouldCycle({
        threads: corrupt,
        threadId: ThreadId.make("c"),
        parentThreadId: ThreadId.make("a"),
      }),
    ).toBe(true);
  });
});

describe("collectThreadDescendants", () => {
  it("returns the whole subtree and never the thread itself", () => {
    const descendants = collectThreadDescendants(threads, ThreadId.make("root"));

    expect([...descendants].toSorted()).toEqual(["child", "grandchild"]);
  });

  it("returns nothing for a leaf", () => {
    expect(collectThreadDescendants(threads, ThreadId.make("grandchild")).size).toBe(0);
  });
});

effectIt.effect("requireThreadLineageAcyclic passes an acyclic parent", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      requireThreadLineageAcyclic({
        readModel,
        command,
        threadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("other"),
      }),
    );

    effectExpect(exit._tag).toBe("Success");
  }),
);

effectIt.effect("requireThreadLineageAcyclic rejects adopting a descendant", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      requireThreadLineageAcyclic({
        readModel,
        command,
        threadId: ThreadId.make("root"),
        parentThreadId: ThreadId.make("child"),
      }),
    );

    effectExpect(exit._tag).toBe("Failure");
  }),
);
