import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as GitManager from "../git/GitManager.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";
import {
  IDLE_SWEEP_EVERY_PASSES,
  idleSweepSlot,
  includeInPeriodicSweep,
  isIdleForSweep,
} from "./threadPullRequestSweep.expbkt3.ts";

const NOW = DateTime.makeUnsafe("2026-10-19T10:00:00.000Z");
const NOW_MS = DateTime.toEpochMillis(NOW);
const hoursAgo = (hours: number) => DateTime.makeUnsafe(NOW_MS - hours * 60 * 60 * 1000);

const threadShell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make(`project-${id}`),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: `feature/${id}`,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: hoursAgo(24 * 30),
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

describe("periodic pull-request sweep rotation", () => {
  it("treats a thread as idle only after a day with no run, message or live work", () => {
    expect(isIdleForSweep(threadShell("old", { latestRunCompletedAt: hoursAgo(25) }), NOW_MS)).toBe(
      true,
    );
    expect(
      isIdleForSweep(threadShell("recent", { latestRunCompletedAt: hoursAgo(2) }), NOW_MS),
    ).toBe(false);
    expect(
      isIdleForSweep(threadShell("messaged", { latestUserMessageAt: hoursAgo(1) }), NOW_MS),
    ).toBe(false);
    expect(isIdleForSweep(threadShell("new", { createdAt: hoursAgo(3) }), NOW_MS)).toBe(false);
    expect(
      isIdleForSweep(
        threadShell("waiting", {
          latestRunCompletedAt: hoursAgo(48),
          activityRunStatus: "waiting",
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it("checks every idle thread exactly once per rotation and active threads on every pass", () => {
    const idle = Array.from({ length: 200 }, (_, index) =>
      threadShell(`idle-${index}`, { latestRunCompletedAt: hoursAgo(72) }),
    );
    const active = threadShell("active", { latestRunCompletedAt: hoursAgo(1) });
    const checks = new Map<string, number>();
    for (let pass = 0; pass < IDLE_SWEEP_EVERY_PASSES; pass += 1) {
      for (const thread of [...idle, active]) {
        if (includeInPeriodicSweep(thread, NOW_MS, pass)) {
          checks.set(thread.id, (checks.get(thread.id) ?? 0) + 1);
        }
      }
    }
    expect(idle.every((thread) => checks.get(thread.id) === 1)).toBe(true);
    expect(checks.get(active.id)).toBe(IDLE_SWEEP_EVERY_PASSES);
    // The slots spread the idle threads instead of bunching them on one pass.
    const perSlot = new Set(idle.map((thread) => idleSweepSlot(thread.id)));
    expect(perSlot.size).toBeGreaterThan(IDLE_SWEEP_EVERY_PASSES / 2);
  });

  it.effect(
    "the service looks up an idle thread once per rotation and an active one every pass",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const idle = threadShell("idle", { latestRunCompletedAt: hoursAgo(72) });
          const active = threadShell("active", { latestRunCompletedAt: hoursAgo(1) });
          const project = (thread: OrchestrationV2ThreadShell): OrchestrationProjectShell => ({
            id: thread.projectId,
            title: thread.title,
            workspaceRoot: `/workspace/${thread.id}`,
            defaultModelSelection: null,
            scripts: [],
            repositoryIdentity: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          });
          const activation = yield* Deferred.make<void>();
          const passes = yield* Queue.unbounded<void>();
          const lookups = new Map<string, number>();
          const layerDependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getShellSnapshot: () =>
                Queue.offer(passes, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [idle, active],
                    archivedThreads: [],
                  }),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project(idle), project(active)]),
            }),
            Layer.mock(GitManager.GitManager)({}),
            Layer.mock(PullRequestService.PullRequestService)({}),
            // No repository identity: the group ends right after this lookup.
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: (root) =>
                Effect.sync(() => {
                  lookups.set(root, (lookups.get(root) ?? 0) + 1);
                  return null;
                }),
            }),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size).fill(1),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
            FileSystem.layerNoop({}),
          );

          yield* Effect.gen(function* () {
            yield* TestClock.setTime(NOW_MS);
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            // The startup pass, then one pass a minute.
            yield* Queue.take(passes);
            yield* service.drain;
            for (let pass = 1; pass < IDLE_SWEEP_EVERY_PASSES; pass += 1) {
              yield* TestClock.adjust("1 minute");
              yield* Queue.take(passes);
              yield* service.drain;
            }
            expect(lookups.get("/workspace/active")).toBe(IDLE_SWEEP_EVERY_PASSES);
            expect(lookups.get("/workspace/idle")).toBe(1);
          }).pipe(Effect.provide(layerDependencies));
        }),
      ),
  );
});
