import {
  AuthSessionId,
  AuthAdministrativeClientScopes,
  AuthStandardClientScopes,
  AuthEnvironmentScopes,
  EnvironmentUserId, // T3-CUSTOM(expbkt3): durable user binding for team mode / Clerk sessions.
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  AuthWebSocketTicketUse,
  type ClientSurface, // T3-CUSTOM(expbkt3): recordClientConnection, which upstream deleted.
  RuntimeMode,
  type ServerAuthSessionMethod,
} from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): session cache TTLs follow the Effect clock.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
// T3-CUSTOM(expbkt3): per-request session lookups use the SQLite reader worker.
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import type {
  ServerAuthInternalError,
  ServerAuthInvalidCredentialError,
} from "./EnvironmentAuth.ts";
import * as PayloadSigner from "./PayloadSigner.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
// T3-CUSTOM(expbkt3): in-memory session row cache (TEC-1837 reconnect storm).
import {
  makeClientConnectionMemo,
  makeVerifiedSessionCache,
} from "./VerifiedSessionCache.expbkt3.ts";
import {
  REUSABLE_DEV_SESSION_EXPIRES_AT,
  REUSABLE_DEV_SESSION_PREFIX,
  resolveReusableDevAuth,
} from "./ReusableDevAuth.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  resolveLegacySessionCookieName,
  resolveSessionCookieName,
} from "./utils.ts";

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly userId: EnvironmentUserId | null; // T3-CUSTOM(expbkt3): durable user binding.
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly userId: EnvironmentUserId | null; // T3-CUSTOM(expbkt3): durable user binding.
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly runtimeModeCeiling?: RuntimeMode;
  /** T3-CUSTOM(expbkt3): an MCP client whose approval held `access:write`. */
  readonly mcpOperator?: boolean;
  /** An MCP client that is another T3 Code environment's peer link. */
  readonly peerLink?: true;
}

export interface VerifiedWebSocketTicket extends VerifiedSession {
  readonly audience?: AuthWebSocketTicketUse;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export class MalformedSessionTokenError extends Schema.TaggedError<MalformedSessionTokenError>()(
  "MalformedSessionTokenError",
  {},
) {
  override get message(): string {
    return "Malformed session token.";
  }
}

export class InvalidSessionTokenSignatureError extends Schema.TaggedError<InvalidSessionTokenSignatureError>()(
  "InvalidSessionTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid session token signature.";
  }
}

export class InvalidSessionTokenPayloadError extends Schema.TaggedError<InvalidSessionTokenPayloadError>()(
  "InvalidSessionTokenPayloadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid session token payload.";
  }
}

export class SessionTokenExpiredError extends Schema.TaggedError<SessionTokenExpiredError>()(
  "SessionTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token expired.";
  }
}

export class UnknownSessionTokenError extends Schema.TaggedError<UnknownSessionTokenError>()(
  "UnknownSessionTokenError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Unknown session token.";
  }
}

export class SessionTokenNotRenewableError extends Schema.TaggedError<SessionTokenNotRenewableError>()(
  "SessionTokenNotRenewableError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Session token cannot be renewed with this key.";
  }
}

export class SessionTokenRevokedError extends Schema.TaggedError<SessionTokenRevokedError>()(
  "SessionTokenRevokedError",
  {
    sessionId: AuthSessionId,
    revokedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Session token revoked.";
  }
}

export class InvalidSessionExpirationClaimError extends Schema.TaggedError<InvalidSessionExpirationClaimError>()(
  "InvalidSessionExpirationClaimError",
  {
    sessionId: AuthSessionId,
    expirationClaim: Schema.Number,
  },
) {
  override get message(): string {
    return "Invalid `exp` claim";
  }
}

export class MalformedWebSocketTokenError extends Schema.TaggedError<MalformedWebSocketTokenError>()(
  "MalformedWebSocketTokenError",
  {},
) {
  override get message(): string {
    return "Malformed websocket token.";
  }
}

export class InvalidWebSocketTokenSignatureError extends Schema.TaggedError<InvalidWebSocketTokenSignatureError>()(
  "InvalidWebSocketTokenSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid websocket token signature.";
  }
}

export class InvalidWebSocketTokenPayloadError extends Schema.TaggedError<InvalidWebSocketTokenPayloadError>()(
  "InvalidWebSocketTokenPayloadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid websocket token payload.";
  }
}

export class WebSocketTokenExpiredError extends Schema.TaggedError<WebSocketTokenExpiredError>()(
  "WebSocketTokenExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket token expired.";
  }
}

export class UnknownWebSocketSessionError extends Schema.TaggedError<UnknownWebSocketSessionError>()(
  "UnknownWebSocketSessionError",
  {
    sessionId: AuthSessionId,
  },
) {
  override get message(): string {
    return "Unknown websocket session.";
  }
}

export class WebSocketSessionExpiredError extends Schema.TaggedError<WebSocketSessionExpiredError>()(
  "WebSocketSessionExpiredError",
  {
    sessionId: AuthSessionId,
    expiresAt: Schema.DateTimeUtc,
    observedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session expired.";
  }
}

export class WebSocketSessionRevokedError extends Schema.TaggedError<WebSocketSessionRevokedError>()(
  "WebSocketSessionRevokedError",
  {
    sessionId: AuthSessionId,
    revokedAt: Schema.DateTimeUtc,
  },
) {
  override get message(): string {
    return "Websocket session revoked.";
  }
}

export const SessionCredentialInvalidError = Schema.Union([
  MalformedSessionTokenError,
  InvalidSessionTokenSignatureError,
  InvalidSessionTokenPayloadError,
  SessionTokenExpiredError,
  UnknownSessionTokenError,
  SessionTokenRevokedError,
  SessionTokenNotRenewableError,
  InvalidSessionExpirationClaimError,
  MalformedWebSocketTokenError,
  InvalidWebSocketTokenSignatureError,
  InvalidWebSocketTokenPayloadError,
  WebSocketTokenExpiredError,
  UnknownWebSocketSessionError,
  WebSocketSessionExpiredError,
  WebSocketSessionRevokedError,
]);
export type SessionCredentialInvalidError = typeof SessionCredentialInvalidError.Type;
export const isSessionCredentialInvalidError = Schema.is(SessionCredentialInvalidError);

const sessionCredentialInternalErrorContext = {
  cause: Schema.Defect(),
};

export class SessionClaimsEncodingError extends Schema.TaggedError<SessionClaimsEncodingError>()(
  "SessionClaimsEncodingError",
  {
    sessionId: AuthSessionId,
    operation: Schema.Literals(["encode_session_claims", "encode_websocket_claims"]),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to encode claims";
  }
}

export class SessionCredentialIssueError extends Schema.TaggedError<SessionCredentialIssueError>()(
  "SessionCredentialIssueError",
  {
    sessionId: Schema.optional(AuthSessionId),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session credential.";
  }
}

export class SessionCredentialVerificationError extends Schema.TaggedError<SessionCredentialVerificationError>()(
  "SessionCredentialVerificationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify session credential.";
  }
}

export class WebSocketTokenIssueError extends Schema.TaggedError<WebSocketTokenIssueError>()(
  "WebSocketTokenIssueError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class WebSocketTokenVerificationError extends Schema.TaggedError<WebSocketTokenVerificationError>()(
  "WebSocketTokenVerificationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to verify websocket token.";
  }
}

export class ActiveSessionsListError extends Schema.TaggedError<ActiveSessionsListError>()(
  "ActiveSessionsListError",
  {
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list active sessions.";
  }
}

export class SessionRevocationError extends Schema.TaggedError<SessionRevocationError>()(
  "SessionRevocationError",
  {
    sessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class OtherSessionsRevocationError extends Schema.TaggedError<OtherSessionsRevocationError>()(
  "OtherSessionsRevocationError",
  {
    currentSessionId: AuthSessionId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export class ProofKeySessionsError extends Schema.TaggedError<ProofKeySessionsError>()(
  "ProofKeySessionsError",
  {
    operation: Schema.Literals(["lookup", "revoke"]),
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} sessions by proof key.`;
  }
}

// T3-CUSTOM(expbkt3): BEGIN — team mode: sessions can be bound to a durable environment
// user and revoked by that user (e.g. removing a member revokes all their sessions).
export class UserSessionsRevocationError extends Schema.TaggedError<UserSessionsRevocationError>()(
  "UserSessionsRevocationError",
  {
    userId: EnvironmentUserId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke user sessions.";
  }
}

export class SessionUserBindingError extends Schema.TaggedError<SessionUserBindingError>()(
  "SessionUserBindingError",
  {
    sessionId: AuthSessionId,
    userId: EnvironmentUserId,
    ...sessionCredentialInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to bind the session to an environment user.";
  }
}
// T3-CUSTOM(expbkt3): END

export const SessionCredentialInternalError = Schema.Union([
  SessionClaimsEncodingError,
  SessionCredentialIssueError,
  SessionCredentialVerificationError,
  WebSocketTokenIssueError,
  WebSocketTokenVerificationError,
  ActiveSessionsListError,
  SessionRevocationError,
  OtherSessionsRevocationError,
  ProofKeySessionsError,
  // T3-CUSTOM(expbkt3): team mode's user-scoped revoke/bind errors.
  UserSessionsRevocationError,
  SessionUserBindingError,
]);
export type SessionCredentialInternalError = typeof SessionCredentialInternalError.Type;
// T3-CUSTOM(expbkt3): predicate used by the fork's auth HTTP surface
// (src/auth/http.ts) to narrow internal credential failures. Present on the
// fork tip; the merge took upstream's version of this region and dropped it.
export const isSessionCredentialInternalError = Schema.is(SessionCredentialInternalError);

export const SessionCredentialError = Schema.Union([
  SessionCredentialInvalidError,
  SessionCredentialInternalError,
]);
export type SessionCredentialError = typeof SessionCredentialError.Type;

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly cookieName: string;
    readonly legacyCookieName: string | undefined;
    readonly issue: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly method?: ServerAuthSessionMethod;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly client?: AuthClientMetadata;
      readonly userId?: EnvironmentUserId; // T3-CUSTOM(expbkt3): bind the issued session to a durable user.
      readonly proofKeyThumbprint?: string;
      readonly runtimeModeCeiling?: RuntimeMode;
      /** T3-CUSTOM(expbkt3): an MCP client whose approval held `access:write`. */
      readonly mcpOperator?: boolean;
      readonly peerLink?: boolean;
      readonly replaceActiveForSubjectAndMethod?: boolean;
      readonly replaceSessionId?: AuthSessionId;
      /** Keeps the session alive this long past each renewal; `ttl` then bounds only the token. */
      readonly renewalWindow?: Duration.Duration;
    }) => Effect.Effect<IssuedSession, SessionCredentialInternalError>;
    /** Trades a renewable token, even an expired one, for a fresh token on the same session. */
    readonly renew: (
      token: string,
      input: {
        readonly proofKeyThumbprint: string;
        readonly ttl: Duration.Duration;
        readonly renewalWindow: Duration.Duration;
        readonly consumeProof: Effect.Effect<
          void,
          ServerAuthInvalidCredentialError | ServerAuthInternalError
        >;
      },
    ) => Effect.Effect<
      IssuedSession,
      SessionCredentialError | ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
    /**
     * Moves a live session's expiry to `expiresAt` unless it is already within `step` of it, and
     * returns the expiry it now has. None when it is revoked, expired or missing.
     */
    readonly extend: (
      sessionId: AuthSessionId,
      expiresAt: DateTime.Utc,
      step: Duration.Duration,
    ) => Effect.Effect<Option.Option<DateTime.Utc>, SessionCredentialInternalError>;
    readonly issueWebSocketToken: (
      sessionId: AuthSessionId,
      input?: {
        readonly ttl?: Duration.Duration;
        readonly audience?: AuthWebSocketTicketUse;
        readonly proofKeyThumbprint?: string;
      },
    ) => Effect.Effect<
      {
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      SessionCredentialInternalError
    >;
    readonly verifyWebSocketToken: (
      token: string,
    ) => Effect.Effect<VerifiedWebSocketTicket, SessionCredentialError>;
    readonly listActive: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      SessionCredentialInternalError
    >;
    readonly streamChanges: Stream.Stream<SessionCredentialChange>;
    /** Completes when a live socket's session is revoked or expires without a renewal for its DPoP key. */
    readonly awaitInvalidation: (
      sessionId: AuthSessionId,
      proofKeyThumbprint?: string,
    ) => Effect.Effect<void, SessionCredentialVerificationError>;
    readonly revoke: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionCredentialInternalError>;
    readonly revokeAllExcept: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    // T3-CUSTOM(expbkt3): BEGIN — team mode: revoke every session for a user, or bind a
    // session to one after the fact (e.g. Clerk sign-in completing on an existing cookie).
    readonly revokeByUserId: (
      userId: EnvironmentUserId,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    readonly bindUserId: (
      sessionId: AuthSessionId,
      userId: EnvironmentUserId,
    ) => Effect.Effect<void, SessionCredentialInternalError>;
    // T3-CUSTOM(expbkt3): END
    readonly proofKeyThumbprintOf: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<string>, SessionCredentialInternalError>;
    /** Revokes every session bound to this DPoP key, so a device it belongs to is cut off now. */
    readonly revokeByProofKey: (
      proofKeyThumbprint: string,
    ) => Effect.Effect<number, SessionCredentialInternalError>;
    readonly markConnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    readonly markDisconnected: (sessionId: AuthSessionId) => Effect.Effect<void, never>;
    // T3-CUSTOM(expbkt3): BEGIN — upstream deleted this as unreached; the fork keeps
    // the client app version that Settings shows for each authorized client.
    readonly recordClientConnection: (
      sessionId: AuthSessionId,
      client: {
        readonly surface?: ClientSurface | undefined;
        readonly appVersion?: string | undefined;
      },
    ) => Effect.Effect<void, never>;
    // T3-CUSTOM(expbkt3): END
  }
>()("t3/auth/SessionStore") {}

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);
const DEFAULT_WEBSOCKET_TOKEN_TTL = Duration.minutes(5);
// T3-CUSTOM(expbkt3): a reconnect within this window keeps the stored last_connected_at.
const LAST_CONNECTED_AT_WRITE_INTERVAL_MS = Duration.toMillis(Duration.minutes(5));

const SessionClaims = Schema.Struct({
  v: Schema.Literals([1, 2]),
  kind: Schema.Literal("session"),
  sid: AuthSessionId,
  sub: Schema.String,
  scopes: AuthEnvironmentScopes,
  method: Schema.Literals(["browser-session-cookie", "bearer-access-token", "dpop-access-token"]),
  jkt: Schema.optionalKey(Schema.String),
  rtc: Schema.optionalKey(RuntimeMode),
  mop: Schema.optionalKey(Schema.Boolean), // T3-CUSTOM(expbkt3): MCP client approved by an operator.
  /** Signed, so a client cannot shed its peer link's limits. */
  plk: Schema.optionalKey(Schema.Literal(1)),
  /** Signed, so only sessions issued as renewable can renew. */
  rnw: Schema.optionalKey(Schema.Literal(1)),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

const WebSocketClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("websocket"),
  sid: AuthSessionId,
  aud: Schema.optionalKey(AuthWebSocketTicketUse),
  jkt: Schema.optionalKey(Schema.String),
  iat: Schema.Number,
  exp: Schema.Number,
});
type WebSocketClaims = typeof WebSocketClaims.Type;

const decodeSessionClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(SessionClaims));
const decodeWebSocketClaims = Schema.decodeUnknownEffect(Schema.fromJsonString(WebSocketClaims));

function createDefaultClientMetadata(): AuthClientMetadata {
  return {
    deviceType: "unknown",
  };
}

function toClientMetadata(record: {
  readonly label: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly deviceType: AuthClientMetadata["deviceType"];
  readonly os: string | null;
  readonly browser: string | null;
  readonly appVersion: string | null; // T3-CUSTOM(expbkt3): client build identity.
}): AuthClientMetadata {
  return {
    ...(record.label ? { label: record.label } : {}),
    ...(record.ipAddress ? { ipAddress: record.ipAddress } : {}),
    ...(record.userAgent ? { userAgent: record.userAgent } : {}),
    deviceType: record.deviceType,
    ...(record.os ? { os: record.os } : {}),
    ...(record.browser ? { browser: record.browser } : {}),
    ...(record.appVersion ? { appVersion: record.appVersion } : {}), // T3-CUSTOM(expbkt3): client build identity.
  };
}

function toAuthClientSession(input: Omit<AuthClientSession, "current">): AuthClientSession {
  return {
    ...input,
    current: false,
  };
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const signer = yield* PayloadSigner.fromSecret(
    yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32),
  );
  const connectedSessionsRef = yield* Ref.make(new Map<AuthSessionId, number>());
  const changesPubSub = yield* PubSub.unbounded<SessionCredentialChange>();
  // T3-CUSTOM(expbkt3): BEGIN — session rows are read through an in-memory cache.
  // Every write below invalidates (or patches) the cache synchronously after it
  // commits and before the change is published, so revocation stays instant.
  const sessionCache = makeVerifiedSessionCache();
  const clientConnections = makeClientConnectionMemo();
  const readSessionRow = Effect.fnUntraced(function* (sessionId: AuthSessionId) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = sessionCache.get(sessionId, nowMs);
    if (cached !== undefined) return Option.fromNullishOr(cached);
    const generation = sessionCache.generation();
    // One SELECT by primary key: the reader, unless a write transaction is open.
    const row = yield* authSessions.getById({ sessionId }).pipe(NodeSqliteClient.readOnly);
    sessionCache.fill(sessionId, Option.getOrNull(row), generation, nowMs);
    return row;
  });
  const invalidateSessions = (sessionIds: ReadonlyArray<AuthSessionId>) =>
    Effect.sync(() => {
      sessionCache.invalidate(sessionIds);
      clientConnections.forget(sessionIds);
    });
  // T3-CUSTOM(expbkt3): END
  // Newest session per DPoP key. A live socket moves to it at expiry, so a
  // client that renews its short-lived token keeps its socket.
  const latestSessionByProofKey = new Map<string, AuthSessionId>();
  const cookieInput = {
    mode: serverConfig.mode,
    port: serverConfig.port,
    host: serverConfig.host,
    instanceKey: serverConfig.stateDir,
    environmentId: yield* serverEnvironment.getEnvironmentId,
    development: serverConfig.devUrl !== undefined,
  } as const;
  const cookieName = resolveSessionCookieName(cookieInput);
  const legacyCookieName = resolveLegacySessionCookieName(cookieInput);
  const devAuth = resolveReusableDevAuth(serverConfig);
  if (devAuth) {
    yield* authSessions
      .createIfAbsent({
        sessionId: devAuth.sessionId,
        // T3-CUSTOM(expbkt3): the dev token is not bound to an environment user.
        userId: null,
        subject: "reusable-dev-token",
        scopes: AuthAdministrativeClientScopes,
        method: "browser-session-cookie",
        client: {
          label: "Reusable dev token",
          ipAddress: null,
          userAgent: null,
          deviceType: "unknown",
          os: null,
          browser: null,
          // T3-CUSTOM(expbkt3): the fork records the connecting app version.
          appVersion: null,
        },
        issuedAt: yield* DateTime.now,
        expiresAt: REUSABLE_DEV_SESSION_EXPIRES_AT,
      })
      .pipe(
        Effect.mapError(
          (cause) => new SessionCredentialIssueError({ sessionId: devAuth.sessionId, cause }),
        ),
      );
  }

  const emitUpsert = (clientSession: AuthClientSession) =>
    PubSub.publish(changesPubSub, {
      type: "clientUpserted",
      clientSession,
    }).pipe(Effect.asVoid);

  const emitRemoved = (sessionId: AuthSessionId) =>
    PubSub.publish(changesPubSub, {
      type: "clientRemoved",
      sessionId,
    }).pipe(Effect.asVoid);

  const loadActiveSession = Effect.fn("SessionStore.loadActiveSession")(function* (
    sessionId: AuthSessionId,
  ) {
    // T3-CUSTOM(expbkt3): read through the session cache.
    const row = yield* readSessionRow(sessionId);
    if (Option.isNone(row) || row.value.revokedAt !== null) {
      return Option.none<AuthClientSession>();
    }

    const connectedSessions = yield* Ref.get(connectedSessionsRef);
    const connected = connectedSessions.has(row.value.sessionId);
    const now = yield* DateTime.now;
    if (!connected && row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
      return Option.none<AuthClientSession>();
    }
    return Option.some(
      toAuthClientSession({
        sessionId: row.value.sessionId,
        userId: row.value.userId, // T3-CUSTOM(expbkt3): durable user binding.
        subject: row.value.subject,
        scopes: row.value.scopes,
        method: row.value.method,
        client: toClientMetadata(row.value.client),
        issuedAt: row.value.issuedAt,
        expiresAt: row.value.expiresAt,
        lastConnectedAt: row.value.lastConnectedAt,
        connected,
      }),
    );
  });

  // T3-CUSTOM(expbkt3): BEGIN — a reconnect storm must not rewrite the row on
  // every connect. Write only when the stored time is unset or at least 5
  // minutes old; Settings shows "connected" from the in-memory socket count,
  // so the timestamp may trail a quick reconnect by up to 5 minutes.
  const refreshLastConnectedAt = Effect.fnUntraced(function* (sessionId: AuthSessionId) {
    const lastConnectedAt = yield* DateTime.now;
    const row = yield* readSessionRow(sessionId);
    if (Option.isNone(row) || row.value.revokedAt !== null) return;
    const previous = row.value.lastConnectedAt;
    if (
      previous !== null &&
      lastConnectedAt.epochMilliseconds - previous.epochMilliseconds <
        LAST_CONNECTED_AT_WRITE_INTERVAL_MS
    ) {
      return;
    }
    yield* authSessions.setLastConnectedAt({ sessionId, lastConnectedAt });
    sessionCache.patch(sessionId, (cached) => ({ ...cached, lastConnectedAt }));
  });
  // T3-CUSTOM(expbkt3): END

  const markConnected: SessionStore["Service"]["markConnected"] = (sessionId) =>
    Ref.modify(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const wasDisconnected = !next.has(sessionId);
      next.set(sessionId, (next.get(sessionId) ?? 0) + 1);
      return [wasDisconnected, next] as const;
    }).pipe(
      Effect.flatMap((wasDisconnected) =>
        // T3-CUSTOM(expbkt3): coalesce reconnects; see refreshLastConnectedAt.
        wasDisconnected ? refreshLastConnectedAt(sessionId) : Effect.void,
      ),
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish connected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markConnected"),
    );

  // T3-CUSTOM(expbkt3): BEGIN — write only when the surface or app version changed,
  // so a reconnect storm does not UPDATE the row on every connect.
  const recordClientConnection: SessionStore["Service"]["recordClientConnection"] = (
    sessionId,
    client,
  ) => {
    const recorded = clientConnections.changes(sessionId, client);
    return recorded === undefined
      ? Effect.void
      : authSessions
          .setClientConnection({
            sessionId,
            surface: client.surface ?? null,
            appVersion: client.appVersion ?? null,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                clientConnections.remember(sessionId, recorded);
                const appVersion = client.appVersion;
                if (appVersion !== undefined) {
                  sessionCache.patch(sessionId, (cached) => ({
                    ...cached,
                    client: { ...cached.client, appVersion },
                  }));
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to record session client connection metadata.").pipe(
                Effect.annotateLogs({ sessionId, cause }),
              ),
            ),
            Effect.withSpan("SessionStore.recordClientConnection"),
          );
  };
  // T3-CUSTOM(expbkt3): END

  const markDisconnected: SessionStore["Service"]["markDisconnected"] = (sessionId) =>
    Ref.update(connectedSessionsRef, (current) => {
      const next = new Map(current);
      const remaining = (next.get(sessionId) ?? 0) - 1;
      if (remaining > 0) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    }).pipe(
      Effect.flatMap(() => loadActiveSession(sessionId)),
      Effect.flatMap((session) =>
        Option.isSome(session) ? emitUpsert(session.value) : emitRemoved(sessionId),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to publish disconnected-session auth update.").pipe(
          Effect.annotateLogs({
            sessionId,
            cause,
          }),
        ),
      ),
      Effect.withSpan("SessionStore.markDisconnected"),
    );

  const encodeClaims = Schema.encodeEffect(Schema.fromJsonString(SessionClaims));
  const signClaims = Effect.fnUntraced(function* (claims: SessionClaims) {
    const encodedPayload = yield* encodeClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new SessionCredentialIssueError({
            sessionId: claims.sid,
            cause: new SessionClaimsEncodingError({
              sessionId: claims.sid,
              operation: "encode_session_claims",
              cause,
            }),
          }),
      ),
    );
    return `${encodedPayload}.${yield* signer.sign(encodedPayload)}`;
  });
  const issue: SessionStore["Service"]["issue"] = Effect.fn("SessionStore.issue")(
    function* (input) {
      const sessionId = AuthSessionId.make(
        yield* random
          .uuidV4()
          .pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ cause }))),
      );
      const issuedAt = yield* DateTime.now;
      const expiresAt = DateTime.add(issuedAt, {
        milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL),
      });
      const sessionExpiresAt = input?.renewalWindow
        ? DateTime.add(issuedAt, { milliseconds: Duration.toMillis(input.renewalWindow) })
        : expiresAt;
      const claims: SessionClaims = {
        v: 1,
        kind: "session",
        sid: sessionId,
        sub: input?.subject ?? "browser",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        method: input?.method ?? "browser-session-cookie",
        ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
        ...(input?.runtimeModeCeiling ? { rtc: input.runtimeModeCeiling } : {}),
        ...(input?.mcpOperator ? { mop: true } : {}), // T3-CUSTOM(expbkt3)
        ...(input?.peerLink === true ? { plk: 1 as const } : {}),
        ...(input?.renewalWindow ? { rnw: 1 as const } : {}),
        iat: issuedAt.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      };

      const token = yield* signClaims(claims);
      const client = input?.client ?? createDefaultClientMetadata();
      const sessionRecord = {
        sessionId,
        // T3-CUSTOM(expbkt3): retain operator identity when replacing desktop sessions.
        userId: input?.userId ?? null,
        subject: claims.sub,
        scopes: claims.scopes,
        method: claims.method,
        client: {
          label: client.label ?? null,
          ipAddress: client.ipAddress ?? null,
          userAgent: client.userAgent ?? null,
          deviceType: client.deviceType,
          os: client.os ?? null,
          browser: client.browser ?? null,
          // T3-CUSTOM(expbkt3): client build identity.
          appVersion: client.appVersion ?? null,
        },
        issuedAt,
        expiresAt: sessionExpiresAt,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      } satisfies AuthSessions.CreateAuthSessionInput;
      const replacedSessionIds = yield* (
        input?.replaceSessionId !== undefined || input?.replaceActiveForSubjectAndMethod
          ? authSessions.createReplacingActive({
              session: sessionRecord,
              revokedAt: issuedAt,
              ...(input.replaceSessionId !== undefined
                ? { replaceSessionId: input.replaceSessionId }
                : {}),
            })
          : authSessions.create(sessionRecord).pipe(Effect.as([] as ReadonlyArray<AuthSessionId>))
      ).pipe(Effect.mapError((cause) => new SessionCredentialIssueError({ sessionId, cause })));
      // T3-CUSTOM(expbkt3): drop a negative entry for the new id and the replaced rows.
      yield* invalidateSessions([sessionId, ...replacedSessionIds]);
      if (claims.jkt) latestSessionByProofKey.set(claims.jkt, sessionId);
      if (replacedSessionIds.length > 0) {
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          for (const replacedSessionId of replacedSessionIds) {
            next.delete(replacedSessionId);
          }
          return next;
        });
        yield* Effect.forEach(replacedSessionIds, emitRemoved, {
          concurrency: "unbounded",
          discard: true,
        });
      }
      yield* emitUpsert(
        toAuthClientSession({
          sessionId,
          userId: input?.userId ?? null,
          subject: claims.sub,
          scopes: claims.scopes,
          method: claims.method,
          client,
          issuedAt,
          expiresAt: sessionExpiresAt,
          lastConnectedAt: null,
          connected: false,
        }),
      );

      return {
        sessionId,
        userId: input?.userId ?? null, // T3-CUSTOM(expbkt3): durable user binding.
        token,
        method: claims.method,
        client,
        expiresAt: expiresAt,
        scopes: claims.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
      } satisfies IssuedSession;
    },
  );

  const verify: SessionStore["Service"]["verify"] = Effect.fn("SessionStore.verify")(
    function* (token) {
      if (devAuth?.matches(token)) {
        // T3-CUSTOM(expbkt3): read through the session cache.
        const row = yield* readSessionRow(devAuth.sessionId).pipe(
          Effect.mapError(
            (cause) =>
              new SessionCredentialVerificationError({ sessionId: devAuth.sessionId, cause }),
          ),
        );
        if (Option.isNone(row)) {
          return yield* new UnknownSessionTokenError({ sessionId: devAuth.sessionId });
        }
        if (row.value.revokedAt !== null) {
          return yield* new SessionTokenRevokedError({
            sessionId: devAuth.sessionId,
            revokedAt: row.value.revokedAt,
          });
        }
        const observedAt = yield* DateTime.now;
        if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
          return yield* new SessionTokenExpiredError({
            sessionId: devAuth.sessionId,
            expiresAt: row.value.expiresAt,
            observedAt,
          });
        }
        return {
          sessionId: row.value.sessionId,
          // T3-CUSTOM(expbkt3): sessions carry the environment user.
          userId: row.value.userId,
          token,
          method: row.value.method,
          client: toClientMetadata(row.value.client),
          expiresAt: row.value.expiresAt,
          subject: row.value.subject,
          scopes: row.value.scopes,
        } satisfies VerifiedSession;
      }
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new MalformedSessionTokenError({});
      }

      if (!(yield* signer.verify(encodedPayload, signature))) {
        return yield* new InvalidSessionTokenSignatureError({});
      }

      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
      );

      const observedAt = yield* DateTime.now;
      const expiresAt = DateTime.make(claims.exp);
      if (Option.isNone(expiresAt)) {
        return yield* new InvalidSessionExpirationClaimError({
          sessionId: claims.sid,
          expirationClaim: claims.exp,
        });
      }
      // A peer link's session renews while it is used and its token is never
      // reissued, so the session row holds its deadline, not the token.
      const rowHoldsDeadline = claims.plk === 1;
      if (!rowHoldsDeadline && claims.exp <= observedAt.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: expiresAt.value,
          observedAt,
        });
      }

      // T3-CUSTOM(expbkt3): cached row, else one SELECT by primary key on the reader.
      const row = yield* readSessionRow(claims.sid).pipe(
        Effect.mapError(
          (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: claims.sid,
          revokedAt: row.value.revokedAt,
        });
      }
      if (
        rowHoldsDeadline &&
        row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds
      ) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: row.value.expiresAt,
          observedAt,
        });
      }

      return {
        sessionId: claims.sid,
        userId: row.value.userId, // T3-CUSTOM(expbkt3): durable user binding.
        token,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt: rowHoldsDeadline ? row.value.expiresAt : expiresAt.value,
        subject: claims.sub,
        scopes: row.value.scopes,
        ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
        ...(claims.rtc ? { runtimeModeCeiling: claims.rtc } : {}),
        ...(claims.mop ? { mcpOperator: true } : {}), // T3-CUSTOM(expbkt3)
        ...(claims.plk === 1 ? { peerLink: true as const } : {}),
      } satisfies VerifiedSession;
    },
  );

  const extend: SessionStore["Service"]["extend"] = Effect.fn("SessionStore.extend")(
    function* (sessionId, expiresAt, step) {
      const now = yield* DateTime.now;
      // The step is checked in the update, so of two uses that read the same expiry one writes.
      const extended = yield* authSessions.extend({
        sessionId,
        expiresAt,
        now,
        onlyIfExpiresBy: DateTime.subtract(expiresAt, { milliseconds: Duration.toMillis(step) }),
      });
      if (!extended) {
        const row = yield* authSessions.getById({ sessionId });
        return Option.filter(
          Option.map(row, (current) => current.expiresAt),
          (current) =>
            Option.exists(row, (session) => session.revokedAt === null) &&
            DateTime.isGreaterThan(current, now),
        );
      }
      const session = yield* loadActiveSession(sessionId);
      if (Option.isSome(session)) yield* emitUpsert(session.value);
      return Option.some(expiresAt);
    },
    (effect, sessionId) =>
      Effect.mapError(
        effect,
        (cause) => new SessionCredentialVerificationError({ sessionId, cause }),
      ),
  );

  const renew: SessionStore["Service"]["renew"] = Effect.fn("SessionStore.renew")(
    function* (token, input) {
      const [encodedPayload, signature] = token.split(".");
      if (!encodedPayload || !signature) {
        return yield* new MalformedSessionTokenError({});
      }
      if (!(yield* signer.verify(encodedPayload, signature))) {
        return yield* new InvalidSessionTokenSignatureError({});
      }
      const claims = yield* decodeSessionClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
        Effect.mapError((cause) => new InvalidSessionTokenPayloadError({ cause })),
      );
      // The token's own expiry is ignored here: the session row's expiry is the renewal window.
      if (claims.rnw !== 1 || claims.jkt !== input.proofKeyThumbprint) {
        return yield* new SessionTokenNotRenewableError({ sessionId: claims.sid });
      }
      const row = yield* authSessions
        .getById({ sessionId: claims.sid })
        .pipe(
          Effect.mapError(
            (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
          ),
        );
      if (Option.isNone(row)) {
        return yield* new UnknownSessionTokenError({ sessionId: claims.sid });
      }
      if (row.value.revokedAt !== null) {
        return yield* new SessionTokenRevokedError({
          sessionId: claims.sid,
          revokedAt: row.value.revokedAt,
        });
      }
      const now = yield* DateTime.now;
      if (row.value.expiresAt.epochMilliseconds <= now.epochMilliseconds) {
        return yield* new SessionTokenExpiredError({
          sessionId: claims.sid,
          expiresAt: row.value.expiresAt,
          observedAt: now,
        });
      }
      yield* input.consumeProof;
      const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(input.ttl) });
      const extended = yield* authSessions
        .extend({
          sessionId: claims.sid,
          expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(input.renewalWindow) }),
          now,
        })
        .pipe(
          Effect.mapError(
            (cause) => new SessionCredentialIssueError({ sessionId: claims.sid, cause }),
          ),
        );
      // A revoke can land between the read above and the update.
      if (!extended) {
        return yield* new SessionTokenNotRenewableError({ sessionId: claims.sid });
      }
      const renewedToken = yield* signClaims({
        ...claims,
        iat: now.epochMilliseconds,
        exp: expiresAt.epochMilliseconds,
      });
      const session = yield* loadActiveSession(claims.sid).pipe(
        Effect.mapError(
          (cause) => new SessionCredentialVerificationError({ sessionId: claims.sid, cause }),
        ),
      );
      if (Option.isSome(session)) yield* emitUpsert(session.value);
      return {
        sessionId: claims.sid,
        userId: row.value.userId, // T3-CUSTOM(expbkt3): renewal keeps the durable user binding.
        token: renewedToken,
        method: claims.method,
        client: toClientMetadata(row.value.client),
        expiresAt,
        scopes: row.value.scopes,
        proofKeyThumbprint: input.proofKeyThumbprint,
      } satisfies IssuedSession;
    },
  );

  const encodeWsClaims = Schema.encodeEffect(Schema.fromJsonString(WebSocketClaims));
  const issueWebSocketToken: SessionStore["Service"]["issueWebSocketToken"] = Effect.fn(
    "SessionStore.issueWebSocketToken",
  )(function* (sessionId, input) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, {
      milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_WEBSOCKET_TOKEN_TTL),
    });
    const claims: WebSocketClaims = {
      v: 1,
      kind: "websocket",
      sid: sessionId,
      ...(input?.audience ? { aud: input.audience } : {}),
      ...(input?.proofKeyThumbprint ? { jkt: input.proofKeyThumbprint } : {}),
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };
    const encodedPayload = yield* encodeWsClaims(claims).pipe(
      Effect.map(base64UrlEncode),
      Effect.mapError(
        (cause) =>
          new WebSocketTokenIssueError({
            sessionId,
            cause: new SessionClaimsEncodingError({
              sessionId,
              operation: "encode_websocket_claims",
              cause,
            }),
          }),
      ),
    );
    const signature = yield* signer.sign(encodedPayload);
    return {
      token: `${encodedPayload}.${signature}`,
      expiresAt,
    };
  });

  const verifyWebSocketToken: SessionStore["Service"]["verifyWebSocketToken"] = Effect.fn(
    "SessionStore.verifyWebSocketToken",
  )(function* (token) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new MalformedWebSocketTokenError({});
    }

    if (!(yield* signer.verify(encodedPayload, signature))) {
      return yield* new InvalidWebSocketTokenSignatureError({});
    }

    const claims = yield* decodeWebSocketClaims(base64UrlDecodeUtf8(encodedPayload)).pipe(
      Effect.mapError((cause) => new InvalidWebSocketTokenPayloadError({ cause })),
    );
    if (claims.sid.startsWith(REUSABLE_DEV_SESSION_PREFIX) && claims.sid !== devAuth?.sessionId) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }

    const observedAt = yield* DateTime.now;
    const expiresAt = DateTime.make(claims.exp);
    if (Option.isNone(expiresAt)) {
      return yield* new InvalidSessionExpirationClaimError({
        sessionId: claims.sid,
        expirationClaim: claims.exp,
      });
    }
    if (claims.exp <= observedAt.epochMilliseconds) {
      return yield* new WebSocketTokenExpiredError({
        sessionId: claims.sid,
        expiresAt: expiresAt.value,
        observedAt,
      });
    }

    // T3-CUSTOM(expbkt3): read through the session cache.
    const row = yield* readSessionRow(claims.sid).pipe(
      Effect.mapError(
        (cause) => new WebSocketTokenVerificationError({ sessionId: claims.sid, cause }),
      ),
    );
    if (Option.isNone(row)) {
      return yield* new UnknownWebSocketSessionError({ sessionId: claims.sid });
    }
    if (row.value.expiresAt.epochMilliseconds <= observedAt.epochMilliseconds) {
      return yield* new WebSocketSessionExpiredError({
        sessionId: claims.sid,
        expiresAt: row.value.expiresAt,
        observedAt,
      });
    }
    if (row.value.revokedAt !== null) {
      return yield* new WebSocketSessionRevokedError({
        sessionId: claims.sid,
        revokedAt: row.value.revokedAt,
      });
    }

    return {
      sessionId: row.value.sessionId,
      userId: row.value.userId, // T3-CUSTOM(expbkt3): durable user binding.
      token,
      method: row.value.method,
      client: toClientMetadata(row.value.client),
      expiresAt: row.value.expiresAt,
      subject: row.value.subject,
      scopes: row.value.scopes,
      ...(claims.aud ? { audience: claims.aud } : {}),
      ...(claims.jkt ? { proofKeyThumbprint: claims.jkt } : {}),
    } satisfies VerifiedWebSocketTicket;
  });

  const listActive: SessionStore["Service"]["listActive"] = Effect.fn("SessionStore.listActive")(
    function* () {
      const now = yield* DateTime.now;
      const connectedSessions = yield* Ref.get(connectedSessionsRef);
      const rows = yield* authSessions.listActive({
        now,
        connectedSessionIds: Array.from(connectedSessions.keys()),
      });

      return rows.map((row) =>
        toAuthClientSession({
          sessionId: row.sessionId,
          userId: row.userId, // T3-CUSTOM(expbkt3): durable user binding.
          subject: row.subject,
          scopes: row.scopes,
          method: row.method,
          client: toClientMetadata(row.client),
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          lastConnectedAt: row.lastConnectedAt,
          connected: connectedSessions.has(row.sessionId),
        }),
      );
    },
    Effect.mapError((cause) => new ActiveSessionsListError({ cause })),
  );

  const revoke: SessionStore["Service"]["revoke"] = Effect.fn("SessionStore.revoke")(
    function* (sessionId) {
      const revokedAt = yield* DateTime.now;
      const revoked = yield* authSessions
        .revoke({
          sessionId,
          revokedAt,
        })
        .pipe(Effect.mapError((cause) => new SessionRevocationError({ sessionId, cause })));
      if (revoked) {
        // T3-CUSTOM(expbkt3): drop the cached row before the removal is published.
        yield* invalidateSessions([sessionId]);
        yield* Ref.update(connectedSessionsRef, (current) => {
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
        yield* emitRemoved(sessionId);
      }
      return revoked;
    },
  );

  const proofKeyThumbprintOf: SessionStore["Service"]["proofKeyThumbprintOf"] = (sessionId) =>
    authSessions
      .getProofKeyThumbprint({ sessionId })
      .pipe(Effect.mapError((cause) => new ProofKeySessionsError({ operation: "lookup", cause })));

  const revokeByProofKey: SessionStore["Service"]["revokeByProofKey"] = Effect.fn(
    "SessionStore.revokeByProofKey",
  )(function* (proofKeyThumbprint) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeByProofKey({ proofKeyThumbprint, revokedAt })
      .pipe(Effect.mapError((cause) => new ProofKeySessionsError({ operation: "revoke", cause })));
    yield* Ref.update(connectedSessionsRef, (current) => {
      const next = new Map(current);
      for (const revokedSessionId of revokedSessionIds) next.delete(revokedSessionId);
      return next;
    });
    yield* Effect.forEach(revokedSessionIds, emitRemoved, { discard: true });
    return revokedSessionIds.length;
  });

  const revokeAllExcept: SessionStore["Service"]["revokeAllExcept"] = Effect.fn(
    "SessionStore.revokeAllExcept",
  )(function* (sessionId) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeAllExcept({
        currentSessionId: sessionId,
        revokedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new OtherSessionsRevocationError({ currentSessionId: sessionId, cause }),
        ),
      );
    if (revokedSessionIds.length > 0) {
      // T3-CUSTOM(expbkt3): drop the cached rows before the removal is published.
      yield* invalidateSessions(revokedSessionIds);
      yield* Ref.update(connectedSessionsRef, (current) => {
        const next = new Map(current);
        for (const revokedSessionId of revokedSessionIds) {
          next.delete(revokedSessionId);
        }
        return next;
      });
      yield* Effect.forEach(
        revokedSessionIds,
        (revokedSessionId) => emitRemoved(revokedSessionId),
        {
          concurrency: "unbounded",
          discard: true,
        },
      );
    }
    return revokedSessionIds.length;
  });

  // T3-CUSTOM(expbkt3): BEGIN — team mode: revoke every session for a user (member
  // removal) and bind an existing session to a user after the fact (Clerk sign-in).
  const revokeByUserId: SessionStore["Service"]["revokeByUserId"] = Effect.fn(
    "SessionStore.revokeByUserId",
  )(function* (userId) {
    const revokedAt = yield* DateTime.now;
    const revokedSessionIds = yield* authSessions
      .revokeByUserId({ userId, revokedAt })
      .pipe(Effect.mapError((cause) => new UserSessionsRevocationError({ userId, cause })));
    if (revokedSessionIds.length > 0) {
      // Drop the cached rows before the removal is published.
      yield* invalidateSessions(revokedSessionIds);
      yield* Ref.update(connectedSessionsRef, (current) => {
        const next = new Map(current);
        for (const sessionId of revokedSessionIds) next.delete(sessionId);
        return next;
      });
      yield* Effect.forEach(revokedSessionIds, emitRemoved, {
        concurrency: "unbounded",
        discard: true,
      });
    }
    return revokedSessionIds.length;
  });

  const bindUserId: SessionStore["Service"]["bindUserId"] = Effect.fn("SessionStore.bindUserId")(
    function* (sessionId, userId) {
      const updated = yield* authSessions
        .setUser({ sessionId, userId })
        .pipe(
          Effect.mapError((cause) => new SessionUserBindingError({ sessionId, userId, cause })),
        );
      // The binding changes who the session acts as: drop the cached row.
      yield* invalidateSessions([sessionId]);
      if (!updated) {
        return yield* new SessionUserBindingError({
          sessionId,
          userId,
          cause: new Error("The session is unavailable."),
        });
      }
      const session = yield* loadActiveSession(sessionId).pipe(
        Effect.mapError((cause) => new SessionUserBindingError({ sessionId, userId, cause })),
      );
      if (Option.isSome(session)) yield* emitUpsert(session.value);
    },
  );
  // T3-CUSTOM(expbkt3): END

  const awaitInvalidation = Effect.fn(function* (
    sessionId: AuthSessionId,
    proofKeyThumbprint?: string,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before reading: revocation can race with the WebSocket upgrade.
        const subscription = yield* PubSub.subscribe(changesPubSub);
        // T3-CUSTOM(expbkt3): read through the session cache.
        const readRow = (id: AuthSessionId) =>
          readSessionRow(id).pipe(
            Effect.mapError(
              (cause) => new SessionCredentialVerificationError({ sessionId: id, cause }),
            ),
          );
        const original = yield* readRow(sessionId);
        if (Option.isNone(original)) return;
        // Media tickets carry no proof key, so their streams follow the session's own.
        const renewalKey =
          proofKeyThumbprint ??
          Option.getOrUndefined(
            yield* authSessions
              .getProofKeyThumbprint({ sessionId })
              .pipe(
                Effect.mapError(
                  (cause) => new SessionCredentialVerificationError({ sessionId, cause }),
                ),
              ),
          );
        // Revoking any session the socket has used closes it. Events only wake this loop
        // and the rows decide: revocations are written before they are published, and
        // clientRemoved also reports an expired session losing its last socket.
        const chain = [sessionId];
        const nextRemoval = Effect.gen(function* () {
          while (true) {
            const change = yield* PubSub.take(subscription);
            if (change.type === "clientRemoved" && chain.includes(change.sessionId)) return;
          }
        });
        let current = original.value;
        while (true) {
          const rows = yield* Effect.forEach(chain, readRow);
          if (rows.some((row) => Option.isNone(row) || row.value.revokedAt !== null)) return;
          // Renewal moves a session's expiry in place, so the snapshot can be stale.
          const currentRow = rows.at(-1);
          if (currentRow !== undefined && Option.isSome(currentRow)) current = currentRow.value;
          const now = yield* DateTime.now;
          const remaining = current.expiresAt.epochMilliseconds - now.epochMilliseconds;
          if (remaining > 0) {
            yield* Effect.raceFirst(nextRemoval, Effect.sleep(Duration.millis(remaining)));
            continue;
          }
          // A renewal can land between the read above and the clock sample.
          const latest = yield* readRow(current.sessionId);
          if (
            Option.isSome(latest) &&
            latest.value.expiresAt.epochMilliseconds > current.expiresAt.epochMilliseconds
          ) {
            current = latest.value;
            continue;
          }
          const successorId =
            renewalKey === undefined ? undefined : latestSessionByProofKey.get(renewalKey);
          if (successorId === undefined || successorId === current.sessionId) return;
          const successor = yield* readRow(successorId);
          // The socket keeps its original scopes, so the renewal must still grant all of them.
          if (
            Option.isNone(successor) ||
            successor.value.subject !== original.value.subject ||
            !original.value.scopes.every((scope) => successor.value.scopes.includes(scope))
          ) {
            return;
          }
          chain.push(successorId);
          current = successor.value;
        }
      }),
    );
  });

  return SessionStore.of({
    cookieName,
    legacyCookieName,
    issue,
    renew,
    extend,
    verify,
    issueWebSocketToken,
    verifyWebSocketToken,
    listActive,
    awaitInvalidation,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    revoke,
    revokeAllExcept,
    proofKeyThumbprintOf,
    revokeByProofKey,
    revokeByUserId, // T3-CUSTOM(expbkt3): team mode member removal.
    bindUserId, // T3-CUSTOM(expbkt3): team mode Clerk sign-in binding.
    markConnected,
    markDisconnected,
    recordClientConnection, // T3-CUSTOM(expbkt3): client app version for Settings.
  });
});

export const layer = Layer.effect(SessionStore, make).pipe(Layer.provideMerge(AuthSessions.layer));
