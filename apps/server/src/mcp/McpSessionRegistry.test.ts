import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  type PersonalMcpIntegration,
  ProviderInstanceId,
  ThreadId,
  TOOLYARD_MCP_URL,
  UserId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.thread?.threadId).toBe(threadId);
    expect(resolved?.capabilities).toEqual(
      // T3-CUSTOM(expbkt3): assert the complete authorized scope set, including retained fork capabilities.
      new Set([
        "preview",
        "orchestration",
        "worktree",
        "pull-requests",
        "t3.read",
        "t3.plan",
        "t3.control",
      ]),
    );

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    // T3-CUSTOM(expbkt3): the fork grants its `t3.*` control-plane capabilities on
    // every provider session, so upstream's exact-equality assertions are narrowed
    // to the capabilities this test actually gates. Equality is kept for those, and
    // the fork's always-on grant is asserted separately below.
    const gatedOf = (issued: typeof withPreview) =>
      capabilitiesOf(issued).pipe(
        Effect.map((capabilities) => capabilities.filter((name) => !name.startsWith("t3."))),
      );

    expect(yield* gatedOf(withPreview)).toEqual([
      "orchestration",
      "preview",
      "pull-requests",
      "worktree",
    ]);
    expect(yield* gatedOf(withoutPreview)).toEqual(["orchestration", "pull-requests", "worktree"]);
    expect(yield* gatedOf(withDevice)).toEqual([
      "device",
      "orchestration",
      "pull-requests",
      "worktree",
    ]);
    // T3-CUSTOM(expbkt3): gating browser/device must never drop the fork's control plane.
    expect(yield* capabilitiesOf(withoutPreview)).toContain("t3.read");
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

// Upstream's liveness window replaced the fork's "never expire on inactivity"
// behaviour; provider turns call touch(), so healthy sessions stay alive.
it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("expires a never-used provider credential at its maximum lifetime", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-3"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 1_001;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

const bearerToken = (issued: { readonly config: { readonly authorizationHeader: string } }) =>
  issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

const makeLoginBoundRegistry = (
  now: () => number,
  logins: ReadonlyMap<
    UserId,
    ReadonlyArray<{ readonly sessionId: AuthSessionId; readonly expiresAtMillis: number }>
  >,
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      idleTimeoutMs: 100,
      maximumLifetimeMs: 1_000,
      listActiveLogins: (userId) => Effect.sync(() => logins.get(userId) ?? []),
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

const loginUserId = UserId.make("user-login");
const loginSessionId = AuthSessionId.make("auth-session-desktop");

it.effect("keeps a login-bound provider credential valid for the whole login", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeLoginBoundRegistry(
      () => timestamp,
      new Map([[loginUserId, [{ sessionId: loginSessionId, expiresAtMillis: 10_000_000 }]]]),
    );
    const threadId = ThreadId.make("thread-login-bound");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const token = bearerToken(issued);
    expect(issued.expiresAt).toBe(10_000_000);

    // Far beyond both the old idle window and the unbound backstop lifetime,
    // with no intervening MCP traffic at all.
    timestamp += 5_000_000;
    expect((yield* registry.resolve(token))?.thread?.threadId).toBe(threadId);
  }),
);

it.effect("denies provider MCP access once the originating login has expired", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeLoginBoundRegistry(
      () => timestamp,
      new Map([[loginUserId, [{ sessionId: loginSessionId, expiresAtMillis: 50_000 }]]]),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-login-expiry"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const token = bearerToken(issued);

    timestamp = 50_001;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("revokes provider credentials when the originating login is revoked", () =>
  Effect.gen(function* () {
    const registry = yield* makeLoginBoundRegistry(
      () => 1_000,
      new Map([[loginUserId, [{ sessionId: loginSessionId, expiresAtMillis: 10_000_000 }]]]),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-logout"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const token = bearerToken(issued);
    expect(yield* registry.resolve(token)).toBeDefined();

    yield* registry.revokeLogin(loginSessionId);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a provider credential alive while any originating login survives", () =>
  Effect.gen(function* () {
    const otherLoginSessionId = AuthSessionId.make("auth-session-phone");
    const unrelatedLoginSessionId = AuthSessionId.make("auth-session-unrelated");
    const registry = yield* makeLoginBoundRegistry(
      () => 1_000,
      new Map([
        [
          loginUserId,
          [
            { sessionId: loginSessionId, expiresAtMillis: 10_000_000 },
            { sessionId: otherLoginSessionId, expiresAtMillis: 20_000_000 },
          ],
        ],
      ]),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-multi-login"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const token = bearerToken(issued);

    yield* registry.revokeLogin(unrelatedLoginSessionId);
    expect(yield* registry.resolve(token)).toBeDefined();

    yield* registry.revokeLogin(loginSessionId);
    expect(yield* registry.resolve(token)).toBeDefined();

    yield* registry.revokeLogin(otherLoginSessionId);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("denies provider MCP access to an actor without any active login", () =>
  Effect.gen(function* () {
    const registry = yield* makeLoginBoundRegistry(() => 1_000, new Map());
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-logged-out"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: UserId.make("user-without-login"),
    });
    expect(yield* registry.resolve(bearerToken(issued))).toBeUndefined();
  }),
);

it.effect("invalidates the previous credential when another user takes over the thread", () =>
  Effect.gen(function* () {
    const handoffUserId = UserId.make("user-handoff");
    const handoffLoginSessionId = AuthSessionId.make("auth-session-handoff");
    const threadId = ThreadId.make("thread-handoff");
    const registry = yield* makeLoginBoundRegistry(
      () => 1_000,
      new Map([
        [loginUserId, [{ sessionId: loginSessionId, expiresAtMillis: 10_000_000 }]],
        [handoffUserId, [{ sessionId: handoffLoginSessionId, expiresAtMillis: 10_000_000 }]],
      ]),
    );
    const first = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const second = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: handoffUserId,
    });

    expect(yield* registry.resolve(bearerToken(first))).toBeUndefined();
    expect((yield* registry.resolve(bearerToken(second)))?.actorUserId).toBe(handoffUserId);
  }),
);

it.effect("revokes every provider credential on shutdown", () =>
  Effect.gen(function* () {
    const registry = yield* makeLoginBoundRegistry(
      () => 1_000,
      new Map([[loginUserId, [{ sessionId: loginSessionId, expiresAtMillis: 10_000_000 }]]]),
    );
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-shutdown"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const token = bearerToken(issued);
    expect(yield* registry.resolve(token)).toBeDefined();

    yield* registry.revokeAll;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("revokes provider credentials when the provider session stops", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread-provider-stop");
    const registry = yield* makeLoginBoundRegistry(
      () => 1_000,
      new Map([[loginUserId, [{ sessionId: loginSessionId, expiresAtMillis: 10_000_000 }]]]),
    );
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: loginUserId,
    });
    const token = bearerToken(issued);
    const providerSessionId = issued.config.providerSessionId;

    yield* registry.revokeProviderSession(providerSessionId);
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("resolves the enabled external operator key without storing it in the registry", () =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadExternalMcpSettings: () =>
          Effect.succeed({
            enabled: true,
            apiKey: "t3exp_12345678901234567890123456789012",
          }),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const resolved = yield* registry.resolve("t3exp_12345678901234567890123456789012");
    expect(resolved?.principal).toBe("external-operator");
    expect(resolved?.capabilities.has("t3.control")).toBe(true);
    expect(yield* registry.resolve("incorrect_123456789012345678901234567890")).toBeUndefined();
  }),
);

it.effect("binds credentials and upstream MCP servers to the actor user", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-tushar");
    const threadId = ThreadId.make("thread-tushar-work");
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadPersonalProfile: (requestedUserId) =>
          Effect.succeed(
            requestedUserId === userId
              ? {
                  userId,
                  externalAccessEnabled: true,
                  externalTokenConfigured: true,
                  externalTokenPrefix: "t3usr_test…",
                  integrations: [
                    {
                      id: "bifrost",
                      name: "Bifrost",
                      url: "https://bifrost.example/mcp",
                      enabled: true,
                      authMode: "x-bf-vk",
                      customHeaderName: "",
                      credentialConfigured: true,
                      providerInstanceIds: [],
                      allowedTools: ["linear_get_issue"],
                    },
                  ],
                  updatedAt: "2026-07-27T00:00:00.000Z",
                }
              : undefined,
          ),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      actorUserId: userId,
    });
    expect(issued.config.actorUserId).toBe(userId);
    expect(issued.config.upstreamServers.map((server) => server.id)).toEqual(["bifrost"]);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.actorUserId).toBe(userId);
    expect(resolved?.capabilities.has("t3.session.create")).toBe(true);
  }),
);

it.effect("grants user-wide session authority to every user-bound ACP", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-priya");
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadPersonalProfile: () =>
          Effect.succeed({
            userId,
            externalAccessEnabled: false,
            externalTokenConfigured: false,
            externalTokenPrefix: "",
            integrations: [],
            updatedAt: "2026-07-27T00:00:00.000Z",
          }),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-priya-work"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: userId,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.actorUserId).toBe(userId);
    expect(resolved?.capabilities.has("t3.session.create")).toBe(true);
  }),
);

it.effect("does not grant user-wide session authority without a bound user", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-local-operator"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      actorUserId: null,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect(resolved?.actorUserId).toBeNull();
    expect(resolved?.capabilities.has("t3.session.create")).toBe(false);
  }),
);

it.effect("pre-registers the shared Bifrost proxy for user sessions before setup", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-bifrost");
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadPersonalProfile: () =>
          Effect.succeed({
            userId,
            externalAccessEnabled: false,
            externalTokenConfigured: false,
            externalTokenPrefix: "",
            integrations: [],
            updatedAt: "2026-07-27T00:00:00.000Z",
          }),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-bifrost"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      actorUserId: userId,
    });

    expect(issued.config.upstreamServers).toEqual([
      {
        id: "bifrost",
        name: "Bifrost",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/bifrost",
        authMode: "x-bf-vk",
        allowedTools: [],
      },
    ]);
  }),
);

it.effect("resolves a personal external token only while the external endpoint is enabled", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-tushar");
    let endpointEnabled = true;
    const registry = yield* McpSessionRegistry.__testing
      .make({
        now: () => 1_000,
        loadExternalMcpSettings: () => Effect.succeed({ enabled: endpointEnabled, apiKey: "" }),
        resolveExternalUserToken: (rawToken) =>
          Effect.succeed(rawToken === "t3usr_personal-token" ? { userId } : undefined),
      })
      .pipe(
        Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        Effect.provide(NodeServices.layer),
      );

    const resolved = yield* registry.resolve("t3usr_personal-token");
    expect(resolved?.principal).toBe("external-user");
    expect(resolved?.actorUserId).toBe(userId);
    expect(resolved?.thread).toBeUndefined();
    expect(resolved?.requestNamespace).toBe(`external-user:${userId}`);
    expect(resolved?.capabilities.has("t3.session.create")).toBe(true);

    endpointEnabled = false;
    expect(yield* registry.resolve("t3usr_personal-token")).toBeUndefined();
  }),
);

// T3-CUSTOM(expbkt3): The wiring between the real auth session store and the
// registry is what makes logout actually cut off provider MCP access, so it is
// exercised through the production layer rather than the injected options.
const makeStubSessionStore = (input: {
  readonly clientSessions: ReadonlyArray<{
    readonly sessionId: AuthSessionId;
    readonly subject: string;
    readonly expiresAt: string;
  }>;
  readonly changes: PubSub.PubSub<SessionStore.SessionCredentialChange>;
}) =>
  SessionStore.SessionStore.of({
    legacyCookieName: undefined,
    cookieName: "t3-session",
    issue: () => Effect.die("unused"),
    verify: () => Effect.die("unused"),
    issueWebSocketToken: () => Effect.die("unused"),
    verifyWebSocketToken: () => Effect.die("unused"),
    // Upstream #8169 records the connecting client's surface; unused by this test.
    recordClientConnection: () => Effect.void,
    listActive: () =>
      Effect.succeed(
        input.clientSessions.map((clientSession) => ({
          sessionId: clientSession.sessionId,
          userId: null,
          subject: clientSession.subject,
          scopes: [],
          method: "browser-session-cookie" as const,
          client: { deviceType: "unknown" as const },
          issuedAt: DateTime.makeUnsafe("2026-07-31T00:00:00.000Z"),
          expiresAt: DateTime.makeUnsafe(clientSession.expiresAt),
          lastConnectedAt: null,
          connected: true,
          current: false,
        })),
      ),
    streamChanges: Stream.fromPubSub(input.changes),
    revoke: () => Effect.die("unused"),
    revokeAllExcept: () => Effect.die("unused"),
    revokeByUserId: () => Effect.die("unused"),
    bindUserId: () => Effect.die("unused"),
    markConnected: () => Effect.void,
    markDisconnected: () => Effect.void,
  });

const eventuallyUnauthorized = (
  registry: McpSessionRegistry.McpSessionRegistryShape,
  token: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* registry.resolve(token)) === undefined) return true;
      yield* Effect.yieldNow;
    }
    return false;
  });

it.effect("cuts off provider MCP access when the auth session store revokes the login", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user_wired");
    const revokedSessionId = AuthSessionId.make("auth-session-wired");
    const changes = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
    const sessionStore = makeStubSessionStore({
      clientSessions: [
        {
          sessionId: revokedSessionId,
          subject: `clerk:${userId}`,
          expiresAt: "2026-12-31T00:00:00.000Z",
        },
      ],
      changes,
    });

    // The whole body runs inside the layer's scope so the revocation
    // subscriber it forks stays alive, exactly as it does in the server.
    yield* Effect.gen(function* () {
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId: ThreadId.make("thread-wired"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        actorUserId: userId,
      });
      const token = bearerToken(issued);
      expect(yield* registry.resolve(token)).toBeDefined();

      // Let the layer's revocation subscriber attach before publishing.
      for (let attempt = 0; attempt < 20; attempt++) yield* Effect.yieldNow;
      yield* PubSub.publish(changes, { type: "clientRemoved", sessionId: revokedSessionId });
      expect(yield* eventuallyUnauthorized(registry, token)).toBe(true);
    }).pipe(
      Effect.provide(
        McpSessionRegistry.layer.pipe(
          Layer.provide(Layer.succeed(SessionStore.SessionStore, sessionStore)),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(Layer.succeed(HttpServer.HttpServer, fakeHttpServer)),
          Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.thread?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

// T3-CUSTOM(expbkt3): the built-in toolyard integration rides along like any
// other configured integration — present exactly when the user is connected.
const toolyardIntegration = (credentialConfigured: boolean): PersonalMcpIntegration => ({
  id: "toolyard",
  name: "toolyard",
  url: TOOLYARD_MCP_URL,
  enabled: true,
  authMode: "bearer",
  customHeaderName: "",
  credentialConfigured,
  providerInstanceIds: [],
  allowedTools: [],
});

const makeRegistryWithProfile = (
  userId: UserId,
  integrations: ReadonlyArray<PersonalMcpIntegration>,
) =>
  McpSessionRegistry.__testing
    .make({
      now: () => 1_000,
      loadPersonalProfile: () =>
        Effect.succeed({
          userId,
          externalAccessEnabled: false,
          externalTokenConfigured: false,
          externalTokenPrefix: "",
          integrations,
          updatedAt: "2026-10-02T00:00:00.000Z",
        }),
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("proxies the built-in toolyard integration once the user is connected", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-toolyard");
    const registry = yield* makeRegistryWithProfile(userId, [toolyardIntegration(true)]);

    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-toolyard"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: userId,
    });

    expect(issued.config.upstreamServers).toEqual([
      {
        id: "toolyard",
        name: "toolyard",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/toolyard",
        authMode: "bearer",
        allowedTools: [],
        configurationKey: expect.stringMatching(/^[a-f0-9]{64}$/), // T3-CUSTOM(expbkt3): stable source identity.
      },
      {
        id: "bifrost",
        name: "Bifrost",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/bifrost",
        authMode: "x-bf-vk",
        allowedTools: [],
      },
    ]);
  }),
);

it.effect("leaves toolyard out of a session until the user is connected", () =>
  Effect.gen(function* () {
    const userId = UserId.make("user-toolyard-pending");
    const registry = yield* makeRegistryWithProfile(userId, [toolyardIntegration(false)]);

    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-toolyard-pending"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      actorUserId: userId,
    });

    expect(issued.config.upstreamServers.map((server) => server.id)).toEqual(["bifrost"]);
  }),
);
