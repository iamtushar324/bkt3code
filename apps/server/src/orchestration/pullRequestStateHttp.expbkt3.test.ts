// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  AuthSessionId,
  CommandId,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  EXTERNAL_PR_SYNC_ENV,
  externalPullRequestSyncEnabled,
  unlessExternalPullRequestSync,
} from "./externalPullRequestSync.expbkt3.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import {
  applyPullRequestState,
  PULL_REQUEST_STATE_PATH,
  type PullRequestStateWrite,
  pullRequestStateRouteLayer,
} from "./pullRequestStateHttp.expbkt3.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const repository = "beknown-work/demo";
const prUrl = `https://github.com/${repository}/pull/7`;

const makeRepo = (remote: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pr-state-"));
      NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
        cwd: dir,
        stdio: "ignore",
      });
      NodeChildProcess.execFileSync("git", ["remote", "add", "origin", remote], {
        cwd: dir,
        stdio: "ignore",
      });
      return dir;
    }),
    (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );

const engineLayer = () =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pr-state-" })),
    Layer.provideMerge(NodeServices.layer),
  );

const createProject = (id: string, workspaceRoot: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-${id}`),
      projectId: ProjectId.make(id),
      title: id,
      workspaceRoot,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      createdAt: "2026-09-26T00:00:00.000Z",
    });
  });

const createThread = (id: string, projectId: string, branch: string | null) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-${id}`),
      threadId: ThreadId.make(id),
      projectId: ProjectId.make(projectId),
      title: id,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch,
      worktreePath: null,
      sourceControlProfileId: null,
      createdAt: "2026-09-26T00:00:00.000Z",
    });
  });

const linkThread = (threadId: string, number = 7) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.pull-request.link",
      commandId: CommandId.make(`cmd-link-${threadId}-${number}`),
      threadId: ThreadId.make(threadId),
      host: "github.com",
      repository,
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      source: "manual",
    });
  });

const readThread = (id: string) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery;
    const thread = yield* snapshots.getThreadShellById(ThreadId.make(id));
    return Option.getOrThrow(thread) as OrchestrationThreadShell;
  });

const write = (overrides: {
  readonly deliveryId?: string;
  readonly number?: number;
  readonly state?: "open" | "closed" | "merged";
  readonly updatedAt?: string;
  readonly title?: string;
}): PullRequestStateWrite => {
  const number = overrides.number ?? 7;
  return {
    deliveryId: overrides.deliveryId ?? "delivery-1",
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    snapshot: {
      state: overrides.state ?? "open",
      title: overrides.title ?? "Add the thing",
      headBranch: "feature/thing",
      baseBranch: "main",
      isDraft: false,
      updatedAt: overrides.updatedAt ?? "2026-09-26T08:00:00.000Z",
      syncedAt: "2026-09-26T08:00:01.000Z",
      additions: 3,
      deletions: 1,
      changedFiles: 2,
      checksState: "pending",
      reviewDecision: null,
    },
  };
};

describe("applyPullRequestState", () => {
  it.effect(
    "refreshes a linked thread's snapshot, then treats replays and older writes as no-ops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* makeRepo(`https://github.com/${repository}.git`);
          yield* createProject("project-1", root);
          yield* createThread("thread-linked", "project-1", null);
          yield* linkThread("thread-linked");

          const first = yield* applyPullRequestState(write({}));
          assert.deepStrictEqual(first, { applied: ["thread-linked"], ignored: [] });
          const link = (yield* readThread("thread-linked")).pullRequests[0];
          assert.strictEqual(link?.snapshot?.title, "Add the thing");
          assert.strictEqual(link?.snapshot?.checksState, "pending");

          const replay = yield* applyPullRequestState(write({}));
          assert.deepStrictEqual(replay.ignored, [
            { threadId: "thread-linked", reason: "unchanged" },
          ]);

          const older = yield* applyPullRequestState(
            write({
              deliveryId: "delivery-0",
              updatedAt: "2026-09-26T07:00:00.000Z",
              title: "Old",
            }),
          );
          assert.deepStrictEqual(older.ignored, [{ threadId: "thread-linked", reason: "stale" }]);
          assert.strictEqual(
            (yield* readThread("thread-linked")).pullRequests[0]?.snapshot?.title,
            "Add the thing",
          );

          const newer = yield* applyPullRequestState(
            write({
              deliveryId: "delivery-2",
              updatedAt: "2026-09-26T09:00:00.000Z",
              state: "merged",
            }),
          );
          assert.deepStrictEqual(newer.applied, ["thread-linked"]);
          assert.strictEqual(
            (yield* readThread("thread-linked")).pullRequests[0]?.snapshot?.state,
            "merged",
          );
        }),
      ).pipe(Effect.provide(engineLayer())),
  );

  it.effect("sets the branch pull request on threads of the same repository only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeRepo(`git@github.com:${repository}.git`);
        const otherRoot = yield* makeRepo("https://github.com/beknown-work/other.git");
        yield* createProject("project-1", root);
        yield* createProject("project-other", otherRoot);
        yield* createThread("thread-branch", "project-1", "feature/thing");
        yield* createThread("thread-other-repo", "project-other", "feature/thing");
        yield* createThread("thread-other-branch", "project-1", "feature/else");

        const result = yield* applyPullRequestState(write({}));
        assert.deepStrictEqual(result, { applied: ["thread-branch"], ignored: [] });
        assert.deepStrictEqual((yield* readThread("thread-branch")).branchPullRequest, {
          projectId: ProjectId.make("project-1"),
          repository,
          number: 7,
          url: prUrl,
        });
        assert.isNull((yield* readThread("thread-other-repo")).branchPullRequest ?? null);

        const again = yield* applyPullRequestState(write({ deliveryId: "delivery-2" }));
        assert.deepStrictEqual(again.ignored, [{ threadId: "thread-branch", reason: "unchanged" }]);

        // An old closed PR on the same branch does not displace the current one.
        const closed = yield* applyPullRequestState(
          write({ deliveryId: "delivery-3", number: 5, state: "closed" }),
        );
        assert.deepStrictEqual(closed.ignored, [{ threadId: "thread-branch", reason: "stale" }]);
        assert.strictEqual((yield* readThread("thread-branch")).branchPullRequest?.number, 7);
      }),
    ).pipe(Effect.provide(engineLayer())),
  );

  it.effect("treats a retried delivery whose update was rejected as stale, not a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeRepo(`https://github.com/${repository}.git`);
        yield* createProject("project-1", root);
        yield* createThread("thread-branch", "project-1", "feature/thing");
        // A first attempt of this delivery lost a race: the engine recorded a
        // rejection under the command id the retry will reuse.
        const engine = yield* OrchestrationEngineService;
        yield* engine
          .dispatch({
            type: "thread.pull-request.sync",
            commandId: CommandId.make("bridge:pr-state:delivery-retry:thread-branch:branch"),
            threadId: ThreadId.make("thread-branch"),
            projectId: ProjectId.make("project-1"),
            snapshotSequence: 0,
            expected: {
              workspaceRoot: root,
              branch: "some/other-branch",
              worktreePath: null,
              linkedPullRequest: null,
              branchPullRequest: null,
            },
            branchPullRequest: null,
          })
          .pipe(Effect.ignore);

        const retried = yield* applyPullRequestState(write({ deliveryId: "delivery-retry" }));
        assert.deepStrictEqual(retried, {
          applied: [],
          ignored: [{ threadId: "thread-branch", reason: "stale" }],
        });
        // A new delivery for the same PR still applies.
        const fresh = yield* applyPullRequestState(write({ deliveryId: "delivery-next" }));
        assert.deepStrictEqual(fresh.applied, ["thread-branch"]);
      }),
    ).pipe(Effect.provide(engineLayer())),
  );

  it.effect("reports nothing when no thread matches", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* applyPullRequestState(write({})), {
        applied: [],
        ignored: [],
      });
    }).pipe(Effect.provide(engineLayer())),
  );
});

describe("POST /api/orchestration/pull-request-state", () => {
  const scopesByToken: Record<string, ReadonlyArray<string>> = {
    syncer: ["orchestration:read", "external-sync:write"],
    admin: ["orchestration:read", "orchestration:operate", "access:write"],
  };
  const authLayer = Layer.succeed(EnvironmentAuth, {
    authenticateHttpRequest: (request: {
      readonly headers: Record<string, string | undefined>;
    }) => {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      return Effect.succeed({
        sessionId: AuthSessionId.make(`session-${token}`),
        userId: null,
        subject: token,
        method: "bearer-access-token",
        scopes: scopesByToken[token] ?? [],
      });
    },
  } as unknown as EnvironmentAuth["Service"]);

  const post = (body: unknown, token = "syncer") =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.post(PULL_REQUEST_STATE_PATH).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      );
      return { status: response.status, body: yield* response.json };
    });

  it.effect("requires the external-sync scope and a valid body", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* HttpRouter.serve(pullRequestStateRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        assert.deepStrictEqual(yield* post(write({})), {
          status: 200,
          body: { applied: [], ignored: [] },
        });
        assert.strictEqual((yield* post(write({}), "admin")).status, 403);
        assert.strictEqual((yield* post({ ...write({}), number: 0 })).status, 400);
        assert.strictEqual((yield* post({ deliveryId: "x" })).status, 400);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, authLayer, engineLayer()))),
  );
});

describe("T3_EXTERNAL_PR_SYNC", () => {
  it("is on only for an explicit truthy value", () => {
    assert.isFalse(externalPullRequestSyncEnabled({}));
    assert.isFalse(externalPullRequestSyncEnabled({ [EXTERNAL_PR_SYNC_ENV]: "0" }));
    assert.isFalse(externalPullRequestSyncEnabled({ [EXTERNAL_PR_SYNC_ENV]: "" }));
    assert.isTrue(externalPullRequestSyncEnabled({ [EXTERNAL_PR_SYNC_ENV]: "1" }));
    assert.isTrue(externalPullRequestSyncEnabled({ [EXTERNAL_PR_SYNC_ENV]: "true" }));
  });

  it.effect("skips the reactor start only while the switch is on", () =>
    Effect.gen(function* () {
      const previous = process.env[EXTERNAL_PR_SYNC_ENV];
      let starts = 0;
      const start = Effect.sync(() => {
        starts += 1;
      });
      try {
        delete process.env[EXTERNAL_PR_SYNC_ENV];
        yield* unlessExternalPullRequestSync("ThreadPullRequestReactor", start);
        process.env[EXTERNAL_PR_SYNC_ENV] = "1";
        yield* unlessExternalPullRequestSync("ThreadPullRequestReactor", start);
      } finally {
        if (previous === undefined) delete process.env[EXTERNAL_PR_SYNC_ENV];
        else process.env[EXTERNAL_PR_SYNC_ENV] = previous;
      }
      assert.strictEqual(starts, 1);
    }),
  );
});
