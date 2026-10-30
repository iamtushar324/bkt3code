// T3-CUSTOM(expbkt3): per-user views of the shared shell feed keep team visibility.
import { assert, describe, it } from "@effect/vitest";
import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { OrchestratorV2 } from "./orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./orchestration-v2/ProviderAdapterRegistry.ts";
import type { ShellFeedBatch, ShellFeedEntry } from "./orchestration-v2/ShellFeed.expbkt3.ts";
import * as ProviderReplayHarness from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  type ActiveShellDelta,
  makeActiveShellView,
  makeArchivedShellView,
} from "./wsV2Visibility.expbkt3.ts";

const owner = UserId.make("user:owner");
const member = UserId.make("user:member");
const stranger = UserId.make("user:stranger");
const projectId = ProjectId.make("project:fork");

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Hidden project",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
  ownerUserId: owner,
};

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId,
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
  }) as OrchestrationV2ThreadShell;

const threadEntry = (
  sequence: number,
  value: OrchestrationV2ThreadShell | null,
  options: {
    readonly threadId?: string;
    readonly changed?: boolean;
    readonly previousAccess?: Extract<ShellFeedEntry, { kind: "thread" }>["previousAccess"];
  } = {},
): ShellFeedEntry => ({
  kind: "thread",
  sequence,
  threadId: value?.id ?? ThreadId.make(options.threadId ?? "missing"),
  shell: value,
  changed: options.changed ?? true,
  previousAccess: options.previousAccess ?? null,
});

const batch = (...entries: ReadonlyArray<ShellFeedEntry>): ShellFeedBatch => ({
  highSequence: entries.reduce((high, entry) => Math.max(high, entry.sequence), 0),
  entries,
});

const projectService = (reads: { count: number }) => ({
  getShell: () =>
    Effect.sync(() => {
      reads.count += 1;
      return Option.some(project);
    }),
});

const noThreadAccess = { projectHasVisibleThread: () => false };

const summary = (items: ReadonlyArray<ActiveShellDelta>) =>
  items.map((item) => {
    switch (item.kind) {
      case "thread.updated":
        return `${item.sequence}:updated:${item.thread.id}`;
      case "thread.removed":
        return `${item.sequence}:removed:${item.threadId}`;
      case "project.updated":
        return `${item.sequence}:project:${item.project.id}`;
      case "project.removed":
        return `${item.sequence}:project-removed:${item.projectId}`;
    }
  });

describe("makeActiveShellView", () => {
  it.effect("hands off from the snapshot without losing or reordering live items", () =>
    Effect.gen(function* () {
      const a = shell("a");
      const view = makeActiveShellView({
        actor: null,
        afterSequence: 10,
        complete: true,
        projects: [project],
        threads: [a],
        feed: noThreadAccess,
        projectService: projectService({ count: 0 }),
      });
      // Batches published between the subscribe and the snapshot read straddle its sequence.
      const first = yield* view.apply(
        batch(
          threadEntry(9, shell("a", { title: "Already in the snapshot" })),
          threadEntry(10, shell("b")),
          threadEntry(11, shell("c")),
        ),
      );
      const second = yield* view.apply(
        batch(threadEntry(12, shell("a", { title: "Renamed" })), threadEntry(13, shell("b"))),
      );
      assert.deepEqual(
        [...summary(first), ...summary(second)],
        ["11:updated:c", "12:updated:a", "13:updated:b"],
      );
    }),
  );

  it.effect("skips unchanged synchronized shells and still advances the cursor", () =>
    Effect.gen(function* () {
      const a = shell("a");
      const view = makeActiveShellView({
        actor: null,
        afterSequence: 0,
        complete: true,
        projects: [project],
        threads: [a],
        feed: noThreadAccess,
        projectService: projectService({ count: 0 }),
      });
      // The first live sighting resynchronizes the row even when the feed saw no change.
      assert.deepEqual(summary(yield* view.apply(batch(threadEntry(1, a, { changed: false })))), [
        "1:updated:a",
      ]);
      const unchanged = yield* view.apply(batch(threadEntry(2, a, { changed: false })));
      assert.deepEqual(summary(unchanged), []);
      // A text-only batch has no entries, only a higher sequence.
      assert.deepEqual(summary(yield* view.apply({ highSequence: 3, entries: [] })), []);
      yield* TestClock.adjust(Duration.seconds(5));
      assert.deepEqual(summary(yield* view.apply({ highSequence: 4, entries: [] })), [
        "4:updated:a",
      ]);
      assert.deepEqual(summary(yield* view.apply({ highSequence: 5, entries: [] })), []);
    }),
  );

  it.effect("an owner and a member see the thread; a stranger never sees its id", () =>
    Effect.gen(function* () {
      const a = shell("a");
      const run = (actor: UserId | null) =>
        Effect.gen(function* () {
          const reads = { count: 0 };
          const view = makeActiveShellView({
            actor,
            afterSequence: 0,
            complete: true,
            projects: actor === null || actor === owner ? [project] : [],
            threads: [],
            feed: noThreadAccess,
            projectService: projectService(reads),
          });
          const items = [
            ...(yield* view.apply(batch(threadEntry(1, a)))),
            ...(yield* view.apply(batch(threadEntry(2, shell("a", { title: "Renamed" }))))),
            ...(yield* view.apply(
              batch(threadEntry(3, shell("a", { archivedAt: DateTime.makeUnsafe(1) }))),
            )),
            ...(yield* view.apply(batch(threadEntry(4, null, { threadId: "a" })))),
          ];
          return { items: summary(items), projectReads: reads.count };
        });

      assert.deepEqual(yield* run(owner), {
        items: ["1:updated:a", "2:updated:a", "3:removed:a"],
        projectReads: 0,
      });
      // The member's sidebar lacks the owner's project, so it arrives once, before the thread.
      assert.deepEqual(yield* run(member), {
        items: ["1:project:project:fork", "1:updated:a", "2:updated:a", "3:removed:a"],
        projectReads: 1,
      });
      const strangerView = yield* run(stranger);
      assert.deepEqual(strangerView, { items: [], projectReads: 0 });
      // An unrestricted operator sees every row; a row it no longer holds is not removed twice.
      assert.deepEqual((yield* run(null)).items, ["1:updated:a", "2:updated:a", "3:removed:a"]);
    }),
  );

  it.effect("removes a revoked thread once and hides projects the user cannot reach", () =>
    Effect.gen(function* () {
      const a = shell("a");
      const view = makeActiveShellView({
        actor: member,
        afterSequence: 0,
        complete: true,
        projects: [project],
        threads: [a],
        feed: noThreadAccess,
        projectService: projectService({ count: 0 }),
      });
      const otherProject = { ...project, id: ProjectId.make("project:other") };
      const items = [
        ...(yield* view.apply(batch(threadEntry(1, shell("a", { memberUserIds: [] }))))),
        ...(yield* view.apply(batch(threadEntry(2, shell("a", { memberUserIds: [] }))))),
        ...(yield* view.apply(
          batch({
            kind: "project",
            sequence: 3,
            projectId: otherProject.id,
            project: otherProject,
          }),
        )),
        ...(yield* view.apply(
          batch({ kind: "project", sequence: 4, projectId: project.id, project }),
        )),
      ];
      // The member lost the only thread that showed this project, so the project goes too.
      assert.deepEqual(summary(items), ["1:removed:a", "4:project-removed:project:fork"]);
    }),
  );

  it.effect("a resumed client loses rows it may hold, and only those", () =>
    Effect.gen(function* () {
      const view = makeActiveShellView({
        actor: member,
        afterSequence: 0,
        complete: false,
        projects: [],
        threads: [],
        feed: noThreadAccess,
        projectService: projectService({ count: 0 }),
      });
      const items = yield* view.applyReplay([
        threadEntry(1, null, {
          threadId: "shared",
          previousAccess: { projectId, ownerUserId: owner, memberUserIds: [member] },
        }),
        threadEntry(2, null, {
          threadId: "private",
          previousAccess: { projectId, ownerUserId: stranger, memberUserIds: [] },
        }),
        threadEntry(3, shell("private", { ownerUserId: stranger, memberUserIds: [] })),
        threadEntry(4, null, { threadId: "before-the-feed", previousAccess: "unknown" }),
      ]);
      assert.deepEqual(summary(items), ["1:removed:shared", "4:removed:before-the-feed"]);
    }),
  );
});

describe("makeArchivedShellView", () => {
  it("sends visible archived rows and removes only rows the client holds", () => {
    const archived = shell("a", { archivedAt: DateTime.makeUnsafe(1) });
    const view = makeArchivedShellView({ actor: member, afterSequence: 0, threads: [archived] });
    const items = [
      ...view.apply(batch(threadEntry(1, { ...archived, title: "Renamed" }))),
      ...view.apply(
        batch(
          threadEntry(
            2,
            shell("hidden", { archivedAt: DateTime.makeUnsafe(1), memberUserIds: [] }),
          ),
        ),
      ),
      ...view.apply(batch(threadEntry(3, shell("a")))),
      ...view.apply(batch(threadEntry(4, null, { threadId: "hidden" }))),
    ];
    assert.deepEqual(
      items.map((item) => `${item.sequence}:${item.kind}`),
      ["1:thread.updated", "3:thread.removed"],
    );
  });
});

const providerInstanceId = ProviderInstanceId.make("codex");
const registry = Layer.mock(ProviderAdapterRegistryV2)({
  get: () => Effect.die("Provider execution is outside this visibility test."),
  list: () => Effect.succeed([providerInstanceId]),
});
const TestLayer = ProviderReplayHarness.layerWithRegistry(
  { name: "live-member-visibility" },
  registry,
  { runEffectWorker: false },
);

it.effect(
  "delivers the hidden parent project before a newly shared thread and removes a revoked thread",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* OrchestratorV2;
      const threadId = ThreadId.make("thread:shared");
      yield* orchestrator.dispatch(
        {
          type: "thread.create",
          commandId: CommandId.make("create:shared"),
          threadId,
          projectId,
          title: "Shared thread",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          memberUserIds: [member],
        },
        { actorUserId: owner },
      );
      // The batched read returns the same shell as the per-thread read.
      const shells = yield* orchestrator.getThreadShells([threadId, ThreadId.make("missing")]);
      const created = shells.get(threadId);
      if (created === undefined) return yield* Effect.die("The created thread must have a shell.");
      assert.deepEqual(created, yield* orchestrator.getThreadShell(threadId));
      assert.equal(shells.size, 1);

      const reads = { count: 0 };
      const view = makeActiveShellView({
        actor: member,
        afterSequence: 0,
        complete: true,
        projects: [],
        threads: [],
        feed: noThreadAccess,
        projectService: projectService(reads),
      });
      const items = [
        ...(yield* view.apply(batch(threadEntry(1, created)))),
        ...(yield* view.apply(batch(threadEntry(2, { ...created, title: "Updated thread" })))),
        ...(yield* view.apply(batch(threadEntry(3, { ...created, memberUserIds: [] })))),
      ];
      assert.deepEqual(
        items.map((item) => item.kind),
        ["project.updated", "thread.updated", "thread.updated", "thread.removed"],
      );
      assert.deepEqual(
        items.map((item) => item.sequence),
        [1, 1, 2, 3],
      );
      assert.equal(reads.count, 1);
    }).pipe(Effect.provide(TestLayer)),
);
