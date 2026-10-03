import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProfileError,
  SourceControlProfileId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { CurrentSourceControlExecutionEnvironment } from "../sourceControl/SourceControlExecutionEnvironment.ts";
import {
  SourceControlProfileService,
  type SourceControlExecutionContext,
} from "../sourceControl/SourceControlProfileService.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { makePullRequestWatchOwnerExecution } from "./forkPullRequestWatchIdentity.expbkt3.ts";
import { v2PullRequestThread } from "./testkit/pullRequestFixtures.ts";

const threadId = ThreadId.make("thread:pr-watch-owner");
const ownerUserId = UserId.make("user:pr-watch-owner");
const profileId = SourceControlProfileId.make("profile-pr-watch-owner");
const ownerContext: SourceControlExecutionContext = {
  profileId,
  provider: "github",
  login: "thread-owner",
  gitName: "Thread Owner",
  gitEmail: "owner@example.test",
  environment: { GH_TOKEN: "test-owner-token", GIT_AUTHOR_EMAIL: "owner@example.test" },
};

const makeHarness = Effect.fn("makePrWatchIdentityHarness")(function* (input: {
  readonly context: SourceControlExecutionContext | null;
  readonly owner?: UserId | null;
  readonly missingThread?: boolean;
  readonly failure?: SourceControlProfileError;
  readonly interrupt?: boolean;
}) {
  const profileReads: Array<{
    threadId: ThreadId;
    owner: UserId | null;
    environment: NodeJS.ProcessEnv | undefined;
  }> = [];
  const shell = {
    ...v2PullRequestThread({
      id: threadId,
      projectId: ProjectId.make("project:pr-watch-owner"),
      title: "Owner watch",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      pullRequests: [],
      latestUserMessageAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
    }),
    ownerUserId: input.owner === undefined ? ownerUserId : input.owner,
    sourceControlProfileId: profileId,
  };
  const withOwner = yield* makePullRequestWatchOwnerExecution.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStoreV2)({
          getThreadShell: () => Effect.succeed(input.missingThread ? null : shell),
        }),
        Layer.mock(SourceControlProfileService)({
          resolveThreadExecutionContext: (id, owner, environment) =>
            Effect.gen(function* () {
              profileReads.push({ threadId: id, owner, environment });
              if (input.failure !== undefined) return yield* input.failure;
              if (input.interrupt) return yield* Effect.interrupt;
              return input.context;
            }),
        }),
      ),
    ),
  );
  let hostReads = 0;
  const read = (kind: "detail" | "activity") =>
    Effect.gen(function* () {
      hostReads++;
      return { kind, identity: yield* CurrentSourceControlExecutionEnvironment };
    });
  // This is the reactor's unchanged pair of concurrent host reads.
  const bothReads = withOwner(
    threadId,
    Effect.all([read("detail"), read("activity")], { concurrency: 2 }),
  );
  return { bothReads, profileReads, hostReads: () => hostReads };
});

describe("pull request watch owner identity", () => {
  it.effect(
    "uses the current thread owner's profile for detail and activity after service capture",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ context: ownerContext });
        const result = yield* harness.bothReads;
        assert.deepStrictEqual(harness.profileReads, [
          { threadId, owner: ownerUserId, environment: {} },
        ]);
        assert.equal(harness.hostReads(), 2);
        assert.deepStrictEqual(
          result.map((read) => read.kind),
          ["detail", "activity"],
        );
        for (const read of result) {
          assert.equal(read.identity?.profileId, profileId);
          assert.equal(read.identity?.environment.GH_TOKEN, "test-owner-token");
          assert.equal(read.identity?.environment.GIT_AUTHOR_EMAIL, "owner@example.test");
        }
        assert.equal(yield* CurrentSourceControlExecutionEnvironment, null);
      }),
  );

  it.effect(
    "keeps machine identity when the resolver returns null, including an ownerless thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ context: null, owner: null });
        const result = yield* harness.bothReads.pipe(
          Effect.provideService(CurrentSourceControlExecutionEnvironment, {
            profileId,
            environment: { GH_TOKEN: "ambient-profile-token" },
          }),
        );
        assert.equal(harness.profileReads[0]?.owner, null);
        assert.deepStrictEqual(
          result.map((read) => read.identity),
          [null, null],
        );
        assert.equal(harness.hostReads(), 2);
      }),
  );

  it.effect("rejects profile resolution errors before either host read", () =>
    Effect.gen(function* () {
      const failure = new SourceControlProfileError({
        operation: "resolve-thread-profile",
        reason: "missing-profile",
        detail: "The owner has no connected source-control profile.",
        threadId,
      });
      const harness = yield* makeHarness({ context: ownerContext, failure });
      const result = yield* harness.bothReads.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure, failure);
      assert.equal(harness.hostReads(), 0);
    }),
  );

  it.effect("rejects a missing thread without profile or host reads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ context: ownerContext, missingThread: true });
      const result = yield* harness.bothReads.pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "thread-not-found");
      assert.deepStrictEqual(harness.profileReads, []);
      assert.equal(harness.hostReads(), 0);
    }),
  );

  it.effect("preserves interruption without a machine fallback", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ context: ownerContext, interrupt: true });
      const result = yield* Effect.exit(harness.bothReads);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
      assert.equal(harness.hostReads(), 0);
    }),
  );
});
