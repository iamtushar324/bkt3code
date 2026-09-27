// T3-CUSTOM(expbkt3): BEGIN — T3 MCP control plane: credentials now carry an actor identity,
// personal upstream MCP integrations, and login-bound lifetimes (see imports and fields below).
/**
 * T3-CUSTOM(expbkt3): Issues and revokes capability-scoped credentials for the
 * experimental T3 MCP endpoint.
 */
import {
  BIFROST_MCP_INTEGRATION_ID,
  PersonalMcpIntegrationId,
  ProviderInstanceId,
  ThreadId,
  userIdFromSubject,
  type AuthSessionId,
  type PersonalMcpProfile,
  type UserId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
// T3-CUSTOM(expbkt3): END
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime"; // T3-CUSTOM(expbkt3): login expiry math.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream"; // T3-CUSTOM(expbkt3): watch auth session changes to revoke credentials on logout.
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as SessionStore from "../auth/SessionStore.ts"; // T3-CUSTOM(expbkt3): tie MCP credentials to logins.
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts"; // T3-CUSTOM(expbkt3): external MCP on/off switch.
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import * as UserMcpProfileStore from "./UserMcpProfileStore.ts"; // T3-CUSTOM(expbkt3): personal MCP integrations + external tokens.

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  // T3-CUSTOM(expbkt3): BEGIN — actor identity for control-plane capabilities, and the
  // caller-gated capability set made optional for pre-existing fork call sites.
  readonly actorUserId?: UserId | null;
  /**
   * Capabilities the caller gates ("preview", "device").
   * T3-CUSTOM(expbkt3): optional — fork call sites that predate upstream's
   * caller-side gate keep the fork's previous unconditional preview grant.
   */
  readonly capabilities?: ReadonlySet<McpInvocationContext.McpCapability>;
  // T3-CUSTOM(expbkt3): END
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
  /** T3-CUSTOM(expbkt3): when the login backing this credential expires. */
  readonly expiresAt: number;
}

/** An authenticated login that keeps a provider MCP credential authorized. */
export interface McpLoginBinding {
  readonly sessionId: AuthSessionId;
  readonly expiresAtMillis: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeLogin: (authSessionId: AuthSessionId) => Effect.Effect<void>; // T3-CUSTOM(expbkt3): revoke on logout.
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  // T3-CUSTOM(expbkt3): BEGIN — a credential's lifetime is now tied to the login(s) that
  // produced it, not just liveness pings.
  /**
   * The authenticated logins this credential was issued from. `undefined` means
   * the credential is not login-derived (single-user/unrestricted local mode)
   * and is governed only by the absolute backstop lifetime.
   */
  readonly loginSessionIds: ReadonlySet<AuthSessionId> | undefined;
  readonly lastAliveAt: number;
  /**
   * T3-CUSTOM(expbkt3): when the login backing this credential expires. Lives
   * on the record because upstream removed `expiresAt` from McpInvocationScope.
   */
  readonly expiresAt: number;
  // T3-CUSTOM(expbkt3): END
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  // T3-CUSTOM(expbkt3): BEGIN — backstop lifetime for credentials that no login governs,
  // and the external-user idle window. Upstream dropped both when it moved to a pure
  // liveness model; the fork still binds credentials to logins.
  /**
   * T3-CUSTOM(expbkt3): backstop lifetime for credentials that no login
   * governs, and the external-user idle window. Upstream dropped both when it
   * moved to a pure liveness model; the fork still binds credentials to logins.
   */
  readonly maximumLifetimeMs?: number;
  readonly idleTimeoutMs?: number;
  // T3-CUSTOM(expbkt3): END
  readonly now?: () => number;
  // T3-CUSTOM(expbkt3): BEGIN — hooks the fork's registry construction wires up: the
  // external-MCP settings switch, personal MCP profiles, external tokens, and active logins.
  readonly loadExternalMcpSettings?: () => Effect.Effect<{
    readonly enabled: boolean;
    readonly apiKey: string;
  }>;
  readonly loadPersonalProfile?: (userId: UserId) => Effect.Effect<PersonalMcpProfile | undefined>;
  readonly resolveExternalUserToken?: (
    rawToken: string,
  ) => Effect.Effect<UserMcpProfileStore.ResolvedPersonalMcpToken | undefined>;
  /**
   * Active authenticated logins for an actor. When configured, every
   * user-bound provider credential is tied to the logins returned here and
   * dies with them.
   */
  readonly listActiveLogins?: (userId: UserId) => Effect.Effect<ReadonlyArray<McpLoginBinding>>;
  // T3-CUSTOM(expbkt3): END
}

// T3-CUSTOM(expbkt3): BEGIN — idle timeout for external-user credentials and the absolute
// backstop lifetime for credentials no login governs (single-user/unrestricted local mode).

// External-user credentials are resolved from persistent settings on every
// request, so their invocation scope can remain short-lived.
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
// Provider MCP credentials are static headers injected when the provider
// process starts. They cannot be rotated underneath a running process, so an
// inactivity timeout would permanently disconnect otherwise-healthy sessions.
// A user-bound credential instead lives exactly as long as the authenticated
// login that produced it; this backstop only bounds credentials that no login
// governs (single-user/unrestricted local mode).
const DEFAULT_MAXIMUM_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
// T3-CUSTOM(expbkt3): END

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the `t3-code` toolkits on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// T3-CUSTOM(expbkt3): BEGIN — constant-time comparison for the external-operator API key.
const tokenHashesMatch = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    NodeCrypto.timingSafeEqual(leftBytes, rightBytes)
  );
};
// T3-CUSTOM(expbkt3): END

// A wildcard bind is reachable on loopback, which is where the provider
// subprocesses run; anything else is announced as the address it bound.
const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const maximumLifetimeMs = options.maximumLifetimeMs ?? DEFAULT_MAXIMUM_LIFETIME_MS; // T3-CUSTOM(expbkt3): backstop for non-login-bound credentials.
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const next = new Map(
      // T3-CUSTOM(expbkt3): a credential must satisfy both bounds — upstream's
      // liveness window (session died without a clean stop) and the fork's
      // login expiry (the authenticated login that produced it has ended).
      Array.from(records).filter(
        ([, record]) =>
          timestamp <= record.expiresAt && timestamp - record.lastAliveAt <= livenessWindowMs,
      ),
    );
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const actorUserId = request.actorUserId ?? null; // T3-CUSTOM(expbkt3): control-plane actor identity.
      // T3-CUSTOM(expbkt3): A user-bound credential is an extension of the
      // login that produced it. It never expires from inactivity, and it dies
      // when every login it was issued from is gone.
      const activeLogins =
        actorUserId === null || options.listActiveLogins === undefined
          ? undefined
          : yield* options.listActiveLogins(actorUserId);
      const loginSessionIds = activeLogins
        ? new Set(activeLogins.map((login) => login.sessionId))
        : undefined;
      const expiresAt = activeLogins
        ? activeLogins.reduce((latest, login) => Math.max(latest, login.expiresAtMillis), issuedAt)
        : issuedAt + maximumLifetimeMs;
      if (activeLogins && activeLogins.length === 0) {
        yield* Effect.logWarning(
          "issuing an unusable provider MCP credential because the actor has no active login",
          { actorUserId, threadId: request.threadId },
        );
      }
      const personalProfile =
        actorUserId === null || options.loadPersonalProfile === undefined
          ? undefined
          : yield* options.loadPersonalProfile(actorUserId);
      const capabilities = new Set<McpInvocationContext.McpCapability>([
        "pull-requests",
        ...(request.capabilities ?? ["preview"]),
        // T3-CUSTOM(expbkt3): the fork's control-plane capabilities ride on every
        // provider session; browser/device stay gated by `request.capabilities`.
        "t3.read",
        "t3.control",
        "t3.plan",
      ]);
      // Every authenticated user-bound provider session may coordinate the
      // user's other accessible sessions. Tool handlers still authorize every
      // target thread/project against actorUserId before reading or mutating it.
      if (actorUserId !== null) capabilities.add("t3.session.create");
      const scope: McpInvocationContext.McpInvocationScope = {
        principal: "provider-session",
        actorUserId,
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities,
        issuedAt,
      };
      const configuredUpstreamServers =
        personalProfile?.integrations
          .filter(
            (integration) =>
              integration.enabled &&
              integration.credentialConfigured &&
              (integration.providerInstanceIds.length === 0 ||
                integration.providerInstanceIds.includes(request.providerInstanceId)),
          )
          .map((integration) => ({
            id: PersonalMcpIntegrationId.make(integration.id),
            name: integration.name,
            endpoint: `${endpoint.slice(0, -"/mcp".length)}/mcp/upstream/${encodeURIComponent(integration.id)}`,
            authMode: integration.authMode,
            allowedTools: integration.allowedTools,
          })) ?? [];
      const upstreamServers =
        actorUserId !== null &&
        !configuredUpstreamServers.some((server) => server.id === BIFROST_MCP_INTEGRATION_ID)
          ? [
              ...configuredUpstreamServers,
              {
                id: PersonalMcpIntegrationId.make(BIFROST_MCP_INTEGRATION_ID),
                name: "Bifrost",
                endpoint: `${endpoint.slice(0, -"/mcp".length)}/mcp/upstream/${BIFROST_MCP_INTEGRATION_ID}`,
                authMode: "x-bf-vk" as const,
                allowedTools: [],
              },
            ]
          : configuredUpstreamServers;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneDead(records, issuedAt));
        // T3-CUSTOM(expbkt3): a thread has exactly one live provider MCP
        // credential. Issuing a new one — the user-handoff path — must strand
        // the previous holder.
        for (const [existingHash, existingRecord] of next) {
          if (existingRecord.scope.threadId === scope.threadId) next.delete(existingHash);
        }
        next.set(tokenHash, {
          tokenHash,
          scope,
          loginSessionIds,
          lastAliveAt: issuedAt,
          expiresAt,
        });
        return { records: next };
      });
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          actorUserId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          upstreamServers,
          capabilities: scope.capabilities,
        },
        expiresAt,
      };
    },
  );

  const resolve: McpSessionRegistryShape["resolve"] = Effect.fn("McpSessionRegistry.resolve")(
    function* (rawToken) {
      if (rawToken.length === 0) return undefined;
      const tokenHash = yield* hashToken(rawToken);
      const timestamp = yield* currentTimeMillis;
      // T3-CUSTOM(expbkt3): renamed to make room for the external-user/operator fallback below.
      const providerScope = yield* SynchronizedRef.modify(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const record = current.get(tokenHash);
        if (!record) return [undefined, { records: current }] as const;
        // T3-CUSTOM(expbkt3): a login-derived credential is only as authorized
        // as its logins.
        if (record.loginSessionIds !== undefined && record.loginSessionIds.size === 0) {
          return [undefined, { records: current }] as const;
        }
        const next = new Map(current);
        next.set(tokenHash, { ...record, lastAliveAt: timestamp });
        return [record.scope, { records: next }] as const;
      });
      if (providerScope) return providerScope;

      // T3-CUSTOM(expbkt3): The server-wide switch controls all long-lived
      // external credentials. Short-lived ACP credentials above remain
      // available so native in-session T3 tools keep working when it is off.
      const externalSettings = yield* (
        options.loadExternalMcpSettings?.() ?? Effect.succeed({ enabled: false, apiKey: "" })
      );
      if (!externalSettings.enabled) return undefined;

      const externalUser =
        options.resolveExternalUserToken === undefined
          ? undefined
          : yield* options.resolveExternalUserToken(rawToken);
      if (externalUser) {
        return {
          principal: "external-user",
          actorUserId: externalUser.userId,
          environmentId,
          threadId: ThreadId.make(`external-user:${externalUser.userId}`),
          providerSessionId: `external-user:${externalUser.userId}`,
          providerInstanceId: ProviderInstanceId.make("external-user"),
          // T3-CUSTOM(expbkt3): an external agent that may already rename a
          // session and dispatch its commands may also tag its pull requests.
          capabilities: new Set([
            "pull-requests",
            "t3.read",
            "t3.control",
            "t3.plan",
            "t3.session.create",
          ]),
          issuedAt: timestamp,
        } satisfies McpInvocationContext.McpInvocationScope;
      }

      if (
        externalSettings.apiKey.length < 24 ||
        !tokenHashesMatch(yield* hashToken(externalSettings.apiKey), tokenHash)
      ) {
        return undefined;
      }
      return {
        principal: "external-operator",
        actorUserId: null,
        environmentId,
        threadId: ThreadId.make("external-operator"),
        providerSessionId: "external-operator",
        providerInstanceId: ProviderInstanceId.make("external-operator"),
        capabilities: new Set(["pull-requests", "t3.read", "t3.control", "t3.plan"]),
        issuedAt: timestamp,
      } satisfies McpInvocationContext.McpInvocationScope;
    },
  );

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        for (const [tokenHash, record] of current) {
          if (record.scope.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.update(state, ({ records }) => ({
      records: new Map(Array.from(records).filter(([, record]) => !predicate(record))),
    }));

  return McpSessionRegistry.of({
    issue,
    resolve,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere((record) => record.scope.providerSessionId === providerSessionId);
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    // T3-CUSTOM(expbkt3): Logging out (or revoking a client) must immediately
    // unauthorize the provider MCP credentials that login produced. A
    // credential issued from several concurrent logins survives until the last
    // of them is gone.
    revokeLogin: Effect.fn("McpSessionRegistry.revokeLogin")(function* (authSessionId) {
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map<string, CredentialRecord>();
        for (const [tokenHash, record] of records) {
          if (record.loginSessionIds === undefined || !record.loginSessionIds.has(authSessionId)) {
            next.set(tokenHash, record);
            continue;
          }
          const remaining = new Set(record.loginSessionIds);
          remaining.delete(authSessionId);
          if (remaining.size > 0) next.set(tokenHash, { ...record, loginSessionIds: remaining });
        }
        return { records: next };
      });
    }),
    revokeAll: SynchronizedRef.set(state, { records: new Map() }),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  // T3-CUSTOM(expbkt3): BEGIN — wires the registry to server settings (external MCP switch),
  // personal MCP profiles/tokens, and active login tracking; revokes credentials on logout.
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const sessions = yield* SessionStore.SessionStore;
    const registry = yield* makeWithOptions({
      loadExternalMcpSettings: () =>
        serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.experimental.externalMcp),
          Effect.orElseSucceed(() => ({ enabled: false, apiKey: "" })),
        ),
      loadPersonalProfile: (userId) =>
        UserMcpProfileStore.getActivePersonalMcpProfile(userId).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
      resolveExternalUserToken: (token) =>
        UserMcpProfileStore.resolveActiveExternalToken(token).pipe(
          Effect.orElseSucceed(() => undefined),
        ),
      listActiveLogins: (userId) =>
        sessions.listActive().pipe(
          Effect.map((clientSessions) =>
            clientSessions
              .filter((clientSession) => userIdFromSubject(clientSession.subject) === userId)
              .map((clientSession) => ({
                sessionId: clientSession.sessionId,
                expiresAtMillis: DateTime.toEpochMillis(clientSession.expiresAt),
              })),
          ),
          // An authorization decision that cannot be verified must not grant
          // access: an unreadable session table yields no logins, so the
          // credential is issued unauthorized. The next provider session start
          // re-issues and recovers once the store is readable again.
          Effect.tapCause(Effect.logError),
          Effect.orElseSucceed((): ReadonlyArray<McpLoginBinding> => []),
        ),
    });
    // T3-CUSTOM(expbkt3): END
    // T3-CUSTOM(expbkt3): Logout and client revocation both remove the auth
    // session; provider MCP credentials issued from it must die with it.
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientRemoved" ? registry.revokeLogin(change.sessionId) : Effect.void,
      ),
      Effect.tapCause(Effect.logError),
      Effect.forkScoped,
    );
    return registry;
  }).pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

// T3-CUSTOM(expbkt3): issuing already strands the thread's previous credential, so a
// handoff to a different user cannot leave the old holder authorized.
export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.issue(request) : Effect.undefined;

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

// T3-CUSTOM(expbkt3): HTTP routes and provider startup must use the exact same
// registry instance. Missing startup state fails closed instead of creating a
// second route-local credential universe.
export const resolveActiveMcpCredential = (
  rawToken: string,
): Effect.Effect<McpInvocationContext.McpInvocationScope | undefined> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.resolve(rawToken) : Effect.succeed(undefined);

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
