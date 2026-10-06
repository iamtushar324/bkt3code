import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProfileId,
  ThreadId,
  UserId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";

import { makePullRequestWatchOwnerExecution } from "../orchestration-v2/forkPullRequestWatchIdentity.expbkt3.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { v2PullRequestThread } from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CurrentSourceControlExecutionEnvironment } from "../sourceControl/SourceControlExecutionEnvironment.ts";
import { SourceControlProfileService } from "../sourceControl/SourceControlProfileService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import type { PullRequestProviderApi } from "./PullRequestProvider.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestService from "./PullRequestService.ts";

const projectId = ProjectId.make("project-pr-watch-cache-test");
const threadId = ThreadId.make("thread-pr-watch-cache-test");
const ownerA = UserId.make("user-pr-watch-cache-a");
const ownerB = UserId.make("user-pr-watch-cache-b");
const profileA = SourceControlProfileId.make("profile-pr-watch-cache-a");
const profileB = SourceControlProfileId.make("profile-pr-watch-cache-b");
const reference = { projectId, host: "github.com", repository: "acme/web", number: 1 };
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Watch cache",
  workspaceRoot: "/watch-cache",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/web",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/web.git",
    },
    provider: "github",
    displayName: "acme/web",
  },
  defaultModelSelection: null,
  scripts: [],
  ownerUserId: ownerA,
  memberUserIds: [ownerB],
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
};

it.effect(
  "partitions real watch caches by owner and rotated credentials with the correct loader identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let owner: UserId | null = ownerA;
        let ownerAToken = "fixture-token-a-v1";
        const hostReads: Array<{
          operation: "detail" | "activity";
          profileId: SourceControlProfileId | null;
          version: string;
        }> = [];
        const identity = Effect.gen(function* () {
          const execution = yield* CurrentSourceControlExecutionEnvironment;
          const version =
            execution === null
              ? "machine"
              : execution.environment.GH_TOKEN === "fixture-token-a-v1"
                ? "a-v1"
                : execution.environment.GH_TOKEN === "fixture-token-a-v2"
                  ? "a-v2"
                  : execution.environment.GH_TOKEN === "fixture-token-b"
                    ? "b"
                    : "unexpected-credential";
          return { profileId: execution?.profileId ?? null, version };
        });
        const recordRead = (operation: "detail" | "activity") =>
          identity.pipe(
            Effect.tap((current) => Effect.sync(() => hostReads.push({ operation, ...current }))),
          );
        const provider: PullRequestProviderApi = {
          kind: "github",
          capabilities: {
            diff: true,
            comment: true,
            actions: ["merge"],
            mergeMethods: ["merge"],
            search: true,
            review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
            reviewers: { request: false, listCandidates: false },
          },
          getViewer: () => identity.pipe(Effect.map((current) => current.version)),
          getViewerPermissions: () =>
            Effect.succeed({
              actions: [],
              comment: false,
              resolve: false,
              verdicts: [],
              requestReviewers: false,
            }),
          withVerifiedCredential: (_input, use) =>
            use({
              accountId: "101",
              viewer: "verified-routing-viewer",
              credentialFingerprint: "fixture-routing-fingerprint",
            }),
          listChangeRequests: () =>
            Effect.succeed({ items: [], truncated: false, continues: true }),
          getChangeRequest: () =>
            recordRead("detail").pipe(
              Effect.map((current) => ({
                number: 1,
                title: "Watched pull request",
                body: `Private content for ${current.version}`,
                url: "https://github.com/acme/web/pull/1",
                author: { login: "author", name: null, avatarUrl: null },
                headBranch: "feature",
                baseBranch: "main",
                state: "open" as const,
                isDraft: false,
                mergeability: "mergeable" as const,
                additions: 1,
                deletions: 0,
                changedFiles: 1,
                createdAt: "2026-10-03T00:00:00.000Z",
                updatedAt: "2026-10-03T00:00:00.000Z",
                mergedAt: null,
                closedAt: null,
                reviewRequestLogins: [],
                labels: [],
                reviewers: [],
                checks: [],
                mergeCapabilities: { merge: true, squash: false, rebase: false },
                viewerPermissions: {
                  actions: [],
                  comment: false,
                  resolve: false,
                  verdicts: [],
                  requestReviewers: false,
                },
              })),
            ),
          getChangeRequestActivity: () =>
            recordRead("activity").pipe(
              Effect.map((current) => ({
                author: { login: current.version, name: null, avatarUrl: null },
                comments: [],
                commentCount: 0,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [],
              })),
            ),
          getDiff: () => Effect.die("unused"),
          runAction: () => Effect.void,
          comment: () => Effect.void,
          updateChangeRequest: () => Effect.void,
          updateComment: () => Effect.void,
          setReaction: () => Effect.void,
          submitReview: () => Effect.void,
          replyToThread: () => Effect.void,
          setThreadResolution: () => Effect.void,
          listReviewerCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
          setReviewerRequest: () => Effect.void,
        };
        const dependencies = yield* Layer.build(
          Layer.mergeAll(
            Layer.succeed(
              PullRequestProviderRegistry.PullRequestProviderRegistry,
              PullRequestProviderRegistry.fromProviders([provider]),
            ),
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => undefined,
            }),
            Layer.mock(ProjectService.ProjectService)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeed(Option.some(project)),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
            Layer.mock(PullRequestFilesViewed.PullRequestFilesViewedRepository)({}),
            // Merge settings are read only by merge actions, which this test never runs.
            Layer.mock(ServerSettings.ServerSettingsService)({}),
            SourceControlRateLimit.layer,
            Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
              Layer.provide(KeyValueStore.layerMemory),
              Layer.provide(NodeServices.layer),
            ),
          ),
        );
        // Construct outside any owner's execution environment, as the reactor layer does.
        const service = yield* Effect.provideContext(PullRequestService.make, dependencies);
        const withOwner = yield* makePullRequestWatchOwnerExecution.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(ProjectionStoreV2)({
                getThreadShell: () =>
                  Effect.succeed({
                    ...v2PullRequestThread({
                      id: threadId,
                      projectId,
                      title: "Watch cache",
                      runtimeMode: "full-access",
                      interactionMode: "default",
                      modelSelection: {
                        instanceId: ProviderInstanceId.make("codex"),
                        model: "gpt-5.4",
                      },
                      branch: null,
                      worktreePath: null,
                      createdAt: "2026-10-03T00:00:00.000Z",
                      updatedAt: "2026-10-03T00:00:00.000Z",
                      pullRequests: [],
                      latestUserMessageAt: null,
                      archivedAt: null,
                      settledOverride: null,
                      settledAt: null,
                    }),
                    ownerUserId: owner,
                  }),
              }),
              Layer.mock(SourceControlProfileService)({
                resolveThreadExecutionContext: () =>
                  Effect.sync(() =>
                    owner === null
                      ? null
                      : {
                          profileId: owner === ownerA ? profileA : profileB,
                          provider: "github" as const,
                          login: owner === ownerA ? "owner-a" : "owner-b",
                          gitName: "Owner",
                          gitEmail: "owner@example.test",
                          environment: {
                            GH_TOKEN: owner === ownerA ? ownerAToken : "fixture-token-b",
                          },
                        },
                  ),
              }),
            ),
          ),
        );
        const read = withOwner(
          threadId,
          Effect.all(
            [service.detail({ ...reference, allowStale: false }), service.activity(reference)],
            { concurrency: 2 },
          ),
        );
        const a = yield* read;
        owner = ownerB;
        const b = yield* read;
        owner = ownerA;
        const cachedA = yield* read;
        assert.equal(hostReads.length, 4);
        assert.equal(a[0].body, "Private content for a-v1");
        assert.equal(a[0].viewer, "owner-a");
        assert.equal(a[1].author?.login, "a-v1");
        assert.equal(b[0].body, "Private content for b");
        assert.equal(b[0].viewer, "owner-b");
        assert.equal(b[1].author?.login, "b");
        assert.deepStrictEqual(cachedA, a);

        ownerAToken = "fixture-token-a-v2";
        const rotatedA = yield* read;
        assert.equal(rotatedA[0].body, "Private content for a-v2");
        assert.equal(rotatedA[0].viewer, "owner-a");
        assert.equal(rotatedA[1].author?.login, "a-v2");
        assert.deepStrictEqual(
          hostReads.toSorted((left, right) =>
            `${left.version}:${left.operation}`.localeCompare(
              `${right.version}:${right.operation}`,
            ),
          ),
          [
            { operation: "activity", profileId: profileA, version: "a-v1" },
            { operation: "detail", profileId: profileA, version: "a-v1" },
            { operation: "activity", profileId: profileA, version: "a-v2" },
            { operation: "detail", profileId: profileA, version: "a-v2" },
            { operation: "activity", profileId: profileB, version: "b" },
            { operation: "detail", profileId: profileB, version: "b" },
          ],
        );

        owner = null;
        const machine = yield* read;
        assert.equal(machine[0].body, "Private content for machine");
        assert.equal(machine[0].viewer, "machine");
        assert.equal(machine[1].author?.login, "machine");
        const cachedMachine = yield* read;
        assert.deepStrictEqual(cachedMachine, machine);
        assert.equal(hostReads.length, 8);
        assert.deepStrictEqual(
          hostReads.slice(-2).map((entry) => entry.profileId),
          [null, null],
        );

        owner = ownerA;
        const routedReference = { ...reference, expectedAccountId: "101" };
        const routed = yield* withOwner(
          threadId,
          service.withRoutingCredential(
            routedReference,
            Effect.all(
              [
                service.detail({ ...routedReference, allowStale: false }),
                service.activity(routedReference),
              ],
              { concurrency: 2 },
            ),
          ),
        );
        assert.equal(routed[0].viewer, "verified-routing-viewer");
        assert.equal(routed[0].body, "Private content for a-v2");
        assert.equal(hostReads.length, 10);
        assert.deepStrictEqual(
          hostReads.slice(-2).map((entry) => entry.profileId),
          [profileA, profileA],
        );
      }),
    ),
);
