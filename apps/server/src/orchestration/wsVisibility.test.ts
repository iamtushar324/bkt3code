/**
 * T3-CUSTOM(expbkt3): Coverage for the per-connection access-control closures.
 *
 * These behaviours previously lived inline in `makeWsRpcLayer` and had no direct
 * unit coverage — only end-to-end exercise through a live websocket. Extracting
 * them into a pure factory makes them constructible with stub services.
 */
import type {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadShell,
  UserId,
} from "@t3tools/contracts";
import { ProjectId, ThreadId, UserId as UserIdSchema } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeWsVisibility } from "./wsVisibility.ts";

const uid = (value: string): UserId => UserIdSchema.make(value);
const OWNER = uid("user_owner");
const BOB = uid("user_bob");

const NOW = "2026-03-01T00:00:00.000Z";

const project = (
  id: string,
  ownerUserId: UserId | null,
  memberUserIds: ReadonlyArray<UserId>,
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/tmp/${id}`,
  defaultModelSelection: null,
  scripts: [],
  ownerUserId,
  memberUserIds,
  createdAt: NOW,
  updatedAt: NOW,
});

const thread = (
  id: string,
  projectId: string,
  ownerUserId: UserId | null,
  memberUserIds: ReadonlyArray<UserId>,
): OrchestrationThreadShell => ({
  // T3-CUSTOM(expbkt3): upstream's linked pull requests; empty on a fresh fixture.
  pullRequests: [],
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  title: id,
  modelSelection: { instanceId: "codex" as never, model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  sourceControlProfileId: null,
  latestTurn: null,
  ownerUserId,
  memberUserIds,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const snapshot = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects,
  threads,
  updatedAt: NOW,
});

/** Minimal stubs — only the members these closures actually reach. */
const stubDeps = (input: {
  readonly active?: OrchestrationShellSnapshot;
  readonly archived?: OrchestrationShellSnapshot;
  readonly threadsById?: ReadonlyArray<OrchestrationThreadShell>;
  readonly projectThreads?: ReadonlyArray<OrchestrationThreadShell>;
  readonly actorUserId: UserId | null;
  readonly canAccessThread?: boolean;
}) => {
  const active = input.active ?? snapshot([], []);
  const archived = input.archived ?? snapshot([], []);
  const byId = input.threadsById ?? active.threads;
  return {
    projectionSnapshotQuery: {
      getShellSnapshot: () => Effect.succeed(active),
      getArchivedShellSnapshot: () => Effect.succeed(archived),
      getThreadShellById: (threadId: string) =>
        Effect.succeed(Option.fromNullishOr(byId.find((entry) => entry.id === threadId))),
      getProjectShellById: (projectId: string) =>
        Effect.succeed(
          Option.fromNullishOr(active.projects.find((entry) => entry.id === projectId)),
        ),
      getThreadShellsByProjectId: (projectId: string) =>
        Effect.succeed(
          (input.projectThreads ?? active.threads).filter((entry) => entry.projectId === projectId),
        ),
    } as never,
    accessControl: {
      canAccessThread: () => Effect.succeed(input.canAccessThread ?? true),
    } as never,
    actorUserId: input.actorUserId,
    actorIsAdmin: false,
  };
};

describe("wsVisibility.requireThreadAccess", () => {
  it.effect("allows every thread when the connection is unrestricted", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(stubDeps({ actorUserId: null }));
      yield* visibility.requireThreadAccess(ThreadId.make("t1"));
    }),
  );

  it.effect("reports a denied thread as not found, without leaking existence", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(stubDeps({ actorUserId: BOB, canAccessThread: false }));
      const error = yield* Effect.flip(visibility.requireThreadAccess(ThreadId.make("t1")));
      // Denials must be indistinguishable from a missing thread.
      expect(error.message).toContain("was not found");
    }),
  );
});

describe("wsVisibility.visibleAggregateIdsForActor", () => {
  it.effect("unions active and archived visible ids", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(
        stubDeps({
          actorUserId: OWNER,
          active: snapshot([project("p1", OWNER, [])], [thread("t1", "p1", OWNER, [])]),
          archived: snapshot([project("p2", OWNER, [])], [thread("t2", "p2", OWNER, [])]),
        }),
      );
      const visible = yield* visibility.visibleAggregateIdsForActor(OWNER);
      expect([...visible.threadIds].sort()).toEqual(["t1", "t2"]);
      expect([...visible.projectIds].sort()).toEqual(["p1", "p2"]);
    }),
  );

  it.effect("omits aggregates the actor cannot see", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(
        stubDeps({
          actorUserId: BOB,
          active: snapshot([project("p1", OWNER, [])], [thread("t1", "p1", OWNER, [])]),
        }),
      );
      const visible = yield* visibility.visibleAggregateIdsForActor(BOB);
      expect([...visible.threadIds]).toEqual([]);
      expect([...visible.projectIds]).toEqual([]);
    }),
  );
});

describe("wsVisibility.applyShellVisibility", () => {
  it.effect("passes events through untouched for an unrestricted connection", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(stubDeps({ actorUserId: null }));
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 1,
        thread: thread("t1", "p1", OWNER, []),
      };
      const events = yield* Stream.runCollect(visibility.applyShellVisibility(Stream.make(event)));
      expect(events.length).toBe(1);
    }),
  );

  it.effect("rewrites an upsert the actor may not see into a removal", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(stubDeps({ actorUserId: BOB }));
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 1,
        thread: thread("t1", "p1", OWNER, []),
      };
      const events = yield* Stream.runCollect(visibility.applyShellVisibility(Stream.make(event)));
      const kinds = [...events].map((entry) => entry.kind);
      expect(kinds).toEqual(["thread-removed"]);
    }),
  );

  it.effect("keeps an upsert for a thread the actor is tagged on", () =>
    Effect.gen(function* () {
      const visibility = makeWsVisibility(stubDeps({ actorUserId: BOB }));
      const event: OrchestrationShellStreamEvent = {
        kind: "thread-upserted",
        sequence: 1,
        thread: thread("t1", "p1", OWNER, [BOB]),
      };
      const events = yield* Stream.runCollect(visibility.applyShellVisibility(Stream.make(event)));
      const kinds = [...events].map((entry) => entry.kind);
      expect(kinds).toEqual(["thread-upserted"]);
    }),
  );
});
