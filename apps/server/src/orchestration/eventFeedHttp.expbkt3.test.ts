import {
  AuthSessionId,
  CommandId,
  type OrchestrationEvent,
  ProjectId,
  ProviderInstanceId,
  UserId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http";

import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import {
  EVENT_FEED_PATH,
  eventFeedRouteLayer,
  parseEventFeedQuery,
  readEventFeedPage,
} from "./eventFeedHttp.expbkt3.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationAccessControl } from "./Services/AccessControl.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

const hiddenProjectId = ProjectId.make("project-hidden");

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
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-event-feed-" })),
    Layer.provideMerge(NodeServices.layer),
    // Team-mode actors see every project except `project-hidden`.
    Layer.provideMerge(
      Layer.succeed(OrchestrationAccessControl, {
        actorFor: (subject: string) =>
          subject === "team-user" ? Option.some(UserId.make("user-team")) : Option.none(),
        canAccessThread: () => Effect.succeed(true),
        canAccessProject: (_userId: UserId, projectId: ProjectId) =>
          Effect.succeed(projectId !== hiddenProjectId),
        canTransferThreadOwnership: () => Effect.succeed(false),
        canTransferProjectOwnership: () => Effect.succeed(false),
      }),
    ),
  );

const createProject = (id: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-${id}`),
      projectId: ProjectId.make(id),
      title: id,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      createdAt: "2026-09-26T00:00:00.000Z",
    });
  });

const sequences = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.map((event) => event.sequence);

describe("parseEventFeedQuery", () => {
  it("applies defaults and bounds", () => {
    assert.deepStrictEqual(parseEventFeedQuery(new URLSearchParams("after=0")), {
      after: 0,
      limit: 500,
      waitSeconds: 0,
    });
    assert.deepStrictEqual(parseEventFeedQuery(new URLSearchParams("after=7&limit=1000&wait=25")), {
      after: 7,
      limit: 1000,
      waitSeconds: 25,
    });
    assert.isString(parseEventFeedQuery(new URLSearchParams("")));
    assert.isString(parseEventFeedQuery(new URLSearchParams("after=-1")));
    assert.isString(parseEventFeedQuery(new URLSearchParams("after=1.5")));
    assert.isString(parseEventFeedQuery(new URLSearchParams("after=0&limit=0")));
    assert.isString(parseEventFeedQuery(new URLSearchParams("after=0&limit=1001")));
    assert.isString(parseEventFeedQuery(new URLSearchParams("after=0&wait=26")));
  });
});

describe("readEventFeedPage", () => {
  it.effect("returns events after the cursor in sequence order, up to the limit", () =>
    Effect.gen(function* () {
      for (const id of ["project-a", "project-b", "project-c"]) yield* createProject(id);

      const page = yield* readEventFeedPage({ after: 0, limit: 2, waitSeconds: 0 }, null);
      assert.strictEqual(page._tag, "Page");
      if (page._tag !== "Page") return;
      assert.deepStrictEqual(sequences(page.events), [1, 2]);
      assert.strictEqual(page.nextAfter, 2);
      assert.strictEqual(page.headSequence, 3);

      const rest = yield* readEventFeedPage({ after: 2, limit: 500, waitSeconds: 0 }, null);
      assert.isTrue(rest._tag === "Page" && rest.nextAfter === 3 && rest.events.length === 1);

      const empty = yield* readEventFeedPage({ after: 3, limit: 500, waitSeconds: 0 }, null);
      assert.isTrue(empty._tag === "Page" && empty.events.length === 0 && empty.nextAfter === 3);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("rejects a cursor ahead of the log", () =>
    Effect.gen(function* () {
      yield* createProject("project-a");
      const result = yield* readEventFeedPage({ after: 9, limit: 500, waitSeconds: 0 }, null);
      assert.deepStrictEqual(result, { _tag: "CursorInvalid", headSequence: 1 });
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("holds an empty read until the next event is committed", () =>
    Effect.gen(function* () {
      yield* createProject("project-a");
      const waiting = yield* Effect.forkChild(
        readEventFeedPage({ after: 1, limit: 500, waitSeconds: 25 }, null),
      );
      for (let tick = 0; tick < 20; tick += 1) yield* Effect.yieldNow;
      assert.isUndefined(waiting.pollUnsafe(), "the read must be parked, not answered empty");
      yield* createProject("project-b");
      const page = yield* Fiber.join(waiting);
      assert.isTrue(page._tag === "Page");
      if (page._tag !== "Page") return;
      assert.deepStrictEqual(sequences(page.events), [2]);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("returns an empty page when the wait elapses", () =>
    Effect.gen(function* () {
      yield* createProject("project-a");
      const waiting = yield* Effect.forkChild(
        readEventFeedPage({ after: 1, limit: 500, waitSeconds: 2 }, null),
      );
      for (let tick = 0; tick < 50 && waiting.pollUnsafe() === undefined; tick += 1) {
        yield* TestClock.adjust("1 second");
      }
      const page = yield* Fiber.join(waiting);
      assert.isTrue(page._tag === "Page" && page.events.length === 0 && page.nextAfter === 1);
    }).pipe(Effect.provide(engineLayer())),
  );

  it.effect("drops events a team actor cannot see but still advances the cursor", () =>
    Effect.gen(function* () {
      yield* createProject("project-a");
      yield* createProject("project-hidden");
      const page = yield* readEventFeedPage(
        { after: 0, limit: 500, waitSeconds: 0 },
        UserId.make("user-team"),
      );
      assert.isTrue(page._tag === "Page");
      if (page._tag !== "Page") return;
      assert.deepStrictEqual(sequences(page.events), [1]);
      assert.strictEqual(page.nextAfter, 2);
    }).pipe(Effect.provide(engineLayer())),
  );
});

describe("GET /api/orchestration/events", () => {
  const scopesByToken: Record<string, ReadonlyArray<string>> = {
    reader: ["orchestration:read"],
    "no-scope": [],
  };
  const authLayer = Layer.succeed(EnvironmentAuth, {
    authenticateHttpRequest: (request: {
      readonly headers: Record<string, string | undefined>;
    }) => {
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const scopes = scopesByToken[token];
      return scopes === undefined
        ? Effect.die(new Error("unexpected token"))
        : Effect.succeed({
            sessionId: AuthSessionId.make(`session-${token}`),
            userId: null,
            subject: token,
            method: "bearer-access-token",
            scopes,
          });
    },
  } as unknown as EnvironmentAuth["Service"]);

  const request = (query: string, token = "reader") =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(
        HttpClientRequest.get(`${EVENT_FEED_PATH}?${query}`).pipe(
          HttpClientRequest.bearerToken(token),
        ),
      );
      return { status: response.status, body: (yield* response.json) as Record<string, unknown> };
    });

  it.effect("serves pages, rejects bad input, stale cursors and missing scope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* HttpRouter.serve(eventFeedRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);
        yield* createProject("project-a");
        yield* createProject("project-b");

        const ok = yield* request("after=0&limit=1");
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.nextAfter, 1);
        assert.strictEqual(ok.body.headSequence, 2);
        const events = ok.body.events as ReadonlyArray<Record<string, unknown>>;
        assert.deepStrictEqual(
          events.map((event) => [event.sequence, event.type, event.aggregateId]),
          [[1, "project.created", "project-a"]],
        );

        assert.strictEqual((yield* request("limit=5")).status, 400);
        const stale = yield* request("after=99");
        assert.deepStrictEqual(stale, {
          status: 410,
          body: { error: "cursor-invalid", headSequence: 2 },
        });
        assert.strictEqual((yield* request("after=0", "no-scope")).status, 403);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, authLayer, engineLayer()))),
  );
});
