/**
 * T3-CUSTOM(expbkt3): `GET /api/presence` takes the MCP bearer credential and
 * scopes the session the same way the control tools do.
 */
import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type UserId as UserIdType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";

import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { PRESENCE_ROUTE_PATH, presenceRouteLayer } from "./presenceHttp.expbkt3.ts";
import type { PresenceReport } from "./presenceModel.ts";
import { PresenceError, UserPresenceService, type PresenceQuery } from "./UserPresenceService.ts";

const ownThreadId = ThreadId.make("thread-own");
const otherThreadId = ThreadId.make("thread-other");
const hiddenThreadId = ThreadId.make("thread-hidden");
const actorUserId = UserId.make("user-actor");

const scope = (
  overrides: Partial<McpInvocationContext.McpInvocationScope>,
): McpInvocationContext.McpInvocationScope => ({
  principal: "provider-session",
  actorUserId,
  environmentId: EnvironmentId.make("environment-presence"),
  requestNamespace: "provider-session",
  thread: {
    threadId: ownThreadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  capabilities: new Set(["t3.read"]),
  issuedAt: 1,
  ...overrides,
});

const tokens = new Map<string, McpInvocationContext.McpInvocationScope>([
  ["in-session", scope({})],
  ["no-read", scope({ capabilities: new Set(["preview"]) })],
  ["user-wide", scope({ capabilities: new Set(["t3.read", "t3.session.create"]) })],
  [
    "external",
    scope({
      principal: "external-user",
      requestNamespace: "external-user:user-actor",
      thread: undefined,
      client: {
        sessionId: "external-user:user-actor",
        label: "External MCP user",
        runtimeModeCeiling: "full-access",
      },
      capabilities: new Set(["t3.read", "t3.session.create"]),
    }),
  ],
]);

const report = (threadId: ThreadId, query: PresenceQuery): PresenceReport =>
  ({
    now: "2026-09-29T12:00:00.000Z",
    trackingSince: "2026-09-29T11:00:00.000Z",
    heartbeatIntervalMs: 25_000,
    leaseTtlMs: 45_000,
    session: {
      sessionId: String(threadId),
      title: null,
      status: "idle",
      isRunning: false,
      needsHumanAttention: false,
      humanAttentionReasons: [],
      archived: false,
    },
    people: [],
    attended: false,
    recommendation: {
      action: "notify-mattermost",
      reason: [query.threadId, query.userId ?? "", query.email ?? ""].join("|"),
      suggestedFollowUpSeconds: 1,
    },
    caveats: [],
  }) satisfies PresenceReport;

const servicesLayer = Layer.mergeAll(
  Layer.mock(McpSessionRegistry.McpSessionRegistry)({
    resolve: (token) => Effect.succeed(tokens.get(token)),
  }),
  Layer.mock(OrchestrationAccessControl)({
    actorFor: () => Option.none(),
    canAccessThread: (_actor: UserIdType, threadId: ThreadId) =>
      Effect.succeed(threadId !== hiddenThreadId),
  }),
  Layer.mock(UserPresenceService)({
    trackingSince: Effect.succeed(null),
    report: (query) =>
      query.threadId === ThreadId.make("thread-missing")
        ? Effect.fail(new PresenceError({ reason: "not-found", message: "missing" }))
        : Effect.succeed(report(query.threadId, query)),
  }),
);

const request = (path: string, token?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(path).pipe(
        token === undefined ? (self) => self : HttpClientRequest.bearerToken(token),
      ),
    );
    return { status: response.status, body: (yield* response.json) as Record<string, unknown> };
  });

describe("GET /api/presence", () => {
  it.effect("authenticates with the MCP bearer and scopes to the credential's session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* HttpRouter.serve(presenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        const unauthenticated = yield* request(PRESENCE_ROUTE_PATH);
        assert.strictEqual(unauthenticated.status, 401);
        assert.strictEqual(unauthenticated.body.error, "invalid_mcp_credential");

        const unknownToken = yield* request(PRESENCE_ROUTE_PATH, "nope");
        assert.strictEqual(unknownToken.status, 401);

        const own = yield* request(PRESENCE_ROUTE_PATH, "in-session");
        assert.strictEqual(own.status, 200);
        assert.deepStrictEqual(
          (own.body.session as { sessionId: string }).sessionId,
          String(ownThreadId),
        );

        const explicitOwn = yield* request(
          `${PRESENCE_ROUTE_PATH}?sessionId=${ownThreadId}&email=a%40b.c&userId=u1`,
          "in-session",
        );
        assert.strictEqual(explicitOwn.status, 200);
        assert.strictEqual(
          (explicitOwn.body.recommendation as { reason: string }).reason,
          `${ownThreadId}|u1|a@b.c`,
        );

        const foreign = yield* request(
          `${PRESENCE_ROUTE_PATH}?sessionId=${otherThreadId}`,
          "in-session",
        );
        assert.strictEqual(foreign.status, 404);
        assert.strictEqual(foreign.body.error, "session-unavailable");

        const noRead = yield* request(PRESENCE_ROUTE_PATH, "no-read");
        assert.strictEqual(noRead.status, 404);

        const invalid = yield* request(`${PRESENCE_ROUTE_PATH}?sessionId=%20`, "in-session");
        assert.strictEqual(invalid.status, 400);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
  );

  it.effect("lets a user-wide credential name any session its actor can see", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* HttpRouter.serve(presenceRouteLayer, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(Layer.build);

        // A user-bound provider credential still means its own session by default.
        const unnamed = yield* request(PRESENCE_ROUTE_PATH, "user-wide");
        assert.strictEqual(unnamed.status, 200);
        assert.strictEqual(
          (unnamed.body.session as { sessionId: string }).sessionId,
          String(ownThreadId),
        );

        const operator = yield* request(PRESENCE_ROUTE_PATH, "external");
        assert.strictEqual(operator.status, 400);

        const visible = yield* request(
          `${PRESENCE_ROUTE_PATH}?sessionId=${otherThreadId}`,
          "user-wide",
        );
        assert.strictEqual(visible.status, 200);

        const hidden = yield* request(
          `${PRESENCE_ROUTE_PATH}?sessionId=${hiddenThreadId}`,
          "user-wide",
        );
        assert.strictEqual(hidden.status, 404);

        const missing = yield* request(
          `${PRESENCE_ROUTE_PATH}?sessionId=thread-missing`,
          "user-wide",
        );
        assert.strictEqual(missing.status, 404);
        assert.strictEqual(missing.body.error, "not-found");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, servicesLayer))),
  );
});
