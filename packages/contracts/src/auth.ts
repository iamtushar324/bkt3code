import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import {
  AuthSessionId,
  ClientSurface,
  EnvironmentUserId,
  ForwardCompatibleArray,
  TrimmedNonEmptyString,
  UserId,
  ClientWebDeployment,
} from "./baseSchemas.ts";

/**
 * Declares the server's overall authentication posture.
 *
 * This is a high-level policy label that tells clients how the environment is
 * expected to be accessed, not a transport detail and not an exhaustive list
 * of every accepted credential.
 *
 * Typical usage:
 * - rendered in auth/pairing UI so the user understands what kind of
 *   environment they are connecting to
 * - used by clients to decide whether silent desktop bootstrap is expected or
 *   whether an explicit pairing flow should be shown
 *
 * Meanings:
 * - `desktop-managed-local`: local desktop-managed environment with narrow
 *   trusted bootstrap, intended to avoid login prompts on the same machine
 * - `loopback-browser`: standalone local server intended for browser pairing on
 *   the same machine
 * - `remote-reachable`: environment intended to be reached from other devices
 *   or networks, where explicit pairing/auth is expected
 * - `unsafe-no-auth`: intentionally unauthenticated mode; this is an explicit
 *   unsafe escape hatch, not a normal deployment mode
 */
export const ServerAuthPolicy = Schema.Literals([
  "desktop-managed-local",
  "loopback-browser",
  "remote-reachable",
  "unsafe-no-auth",
]);
export type ServerAuthPolicy = typeof ServerAuthPolicy.Type;

/**
 * A credential type that can be exchanged for a real authenticated session.
 *
 * Bootstrap methods are for establishing trust at the start of a connection or
 * pairing flow. They are not the long-lived credential used for ordinary
 * authenticated HTTP / WebSocket traffic after pairing succeeds.
 *
 * Current methods:
 * - `desktop-bootstrap`: a trusted local desktop handoff, used so the desktop
 *   shell can pair the renderer without a login screen
 * - `one-time-token`: a short-lived pairing token, suitable for manual pairing
 *   flows such as `/pair?token=...`
 */
export const ServerAuthBootstrapMethod = Schema.Literals(["desktop-bootstrap", "one-time-token"]);
export type ServerAuthBootstrapMethod = typeof ServerAuthBootstrapMethod.Type;

/**
 * A credential type accepted for steady-state authenticated requests after a
 * client has already paired.
 *
 * These methods are used by the server-wide auth layer for privileged HTTP and
 * WebSocket access. They are distinct from bootstrap methods so clients can
 * reason clearly about "pair first, then use session auth".
 *
 * Current methods:
 * - `browser-session-cookie`: cookie-backed browser session, used by the web
 *   app after bootstrap/pairing
 * - `bearer-access-token`: scoped token suitable for non-cookie or
 *   non-browser clients
 * - `dpop-access-token`: scoped proof-of-possession token used by managed
 *   relay connections
 */
export const ServerAuthSessionMethod = Schema.Literals([
  "browser-session-cookie",
  "bearer-access-token",
  "dpop-access-token",
]);
export type ServerAuthSessionMethod = typeof ServerAuthSessionMethod.Type;

export const AuthOrchestrationReadScope = "orchestration:read" as const;
export const AuthOrchestrationOperateScope = "orchestration:operate" as const;
export const AuthTerminalOperateScope = "terminal:operate" as const;
export const AuthReviewWriteScope = "review:write" as const;
export const AuthAccessReadScope = "access:read" as const;
export const AuthAccessWriteScope = "access:write" as const;
export const AuthRelayReadScope = "relay:read" as const;
export const AuthRelayWriteScope = "relay:write" as const;
// T3-CUSTOM(expbkt3): lets an external syncer (the Linear bridge) write pull-request state.
// Never part of the standard or administrative sets; granted with `auth session issue --with-scope`.
export const AuthExternalSyncWriteScope = "external-sync:write" as const;
export const AuthEnvironmentScope = Schema.Literals([
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthReviewWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  // T3-CUSTOM(expbkt3): external-sync write scope.
  AuthExternalSyncWriteScope,
]);
export type AuthEnvironmentScope = typeof AuthEnvironmentScope.Type;
export const AuthEnvironmentScopes = Schema.Array(AuthEnvironmentScope);
export type AuthEnvironmentScopes = typeof AuthEnvironmentScopes.Type;

export const AuthStandardClientScopes = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthReviewWriteScope,
  AuthRelayReadScope,
] as const;
export const AuthAdministrativeScopes = [
  ...AuthStandardClientScopes,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthRelayWriteScope,
] as const;

export const AuthTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const AuthAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const AuthEnvironmentBootstrapTokenType =
  "urn:t3:params:oauth:token-type:environment-bootstrap" as const;

/**
 * Server-advertised auth capabilities for a specific execution environment.
 *
 * Clients should treat this as the authoritative description of how that
 * environment expects to be paired and how authenticated requests should be
 * made afterward.
 *
 * Field meanings:
 * - `policy`: high-level auth posture for the environment
 * - `bootstrapMethods`: pairing/bootstrap methods the server is currently
 *   willing to accept
 * - `sessionMethods`: authenticated request/session methods the server supports
 *   once pairing is complete
 * - `sessionCookieName`: cookie name clients should expect when
 *   `browser-session-cookie` is in use
 *
 * This descriptor is intentionally capability-oriented. It lets clients choose
 * the right UX without embedding server-specific auth logic or assuming a
 * single access method.
 */
/**
 * Runtime hint that lets the SPA detect team mode and configure its Clerk
 * sign-in surface without any build-time coupling. Present only when the server
 * is configured with a Clerk secret (team mode); absent for single-user
 * desktop/local deployments.
 */
export const ServerAuthClerkDescriptor = Schema.Struct({
  publishableKey: TrimmedNonEmptyString,
  organizationId: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerAuthClerkDescriptor = typeof ServerAuthClerkDescriptor.Type;

export const ServerAuthDescriptor = Schema.Struct({
  policy: ServerAuthPolicy,
  // T3-CUSTOM(expbkt3): bootstrap methods grow over time, so drop ones this
  // build does not know rather than failing the whole descriptor decode — the
  // same treatment `ServerConfig` already gives `issues` and `availableEditors`.
  // Without it, a server advertising a method the client has never heard of
  // makes `server.getConfig` undecodable and the client closes the socket, which
  // is what a fork-only `clerk-session` value did to stock T3 Code clients.
  bootstrapMethods: ForwardCompatibleArray(ServerAuthBootstrapMethod),
  sessionMethods: Schema.Array(ServerAuthSessionMethod),
  sessionCookieName: TrimmedNonEmptyString,
  clerk: Schema.optionalKey(ServerAuthClerkDescriptor),
});
export type ServerAuthDescriptor = typeof ServerAuthDescriptor.Type;

export const AuthClerkSessionRequest = Schema.Struct({
  token: TrimmedNonEmptyString,
  // T3-CUSTOM(expbkt3): direct hosted clients also report their build.
  client_version: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClerkSessionRequest = typeof AuthClerkSessionRequest.Type;

/** Subject-string encoding for a Clerk-authenticated operator. */
const CLERK_SUBJECT_PREFIX = "clerk:";

export const clerkSubjectForUser = (userId: UserId): string => `${CLERK_SUBJECT_PREFIX}${userId}`;

/**
 * Decode a session subject back into a Clerk `UserId`, or `null` when the
 * subject is not a Clerk operator (pairing, CLI, desktop bootstrap ⇒
 * unrestricted local mode).
 */
export const userIdFromSubject = (subject: string): UserId | null => {
  if (!subject.startsWith(CLERK_SUBJECT_PREFIX)) return null;
  const raw = subject.slice(CLERK_SUBJECT_PREFIX.length).trim();
  return raw.length > 0 ? (raw as UserId) : null;
};

export const AuthBrowserSessionRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  identityToken: Schema.optionalKey(TrimmedNonEmptyString),
  // T3-CUSTOM(expbkt3): direct hosted clients also report their build.
  client_version: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthBrowserSessionRequest = typeof AuthBrowserSessionRequest.Type;

export const AuthIdentityBindingRequest = Schema.Struct({
  identityToken: TrimmedNonEmptyString,
});
export type AuthIdentityBindingRequest = typeof AuthIdentityBindingRequest.Type;

export const AuthIdentityBindingResult = Schema.Struct({
  userId: EnvironmentUserId,
});
export type AuthIdentityBindingResult = typeof AuthIdentityBindingResult.Type;

export const AuthBrowserSessionResult = Schema.Struct({
  authenticated: Schema.Literal(true),
  scopes: AuthEnvironmentScopes,
  sessionMethod: ServerAuthSessionMethod,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthBrowserSessionResult = typeof AuthBrowserSessionResult.Type;

export const AuthClientMetadataDeviceType = Schema.Literals([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);
export type AuthClientMetadataDeviceType = typeof AuthClientMetadataDeviceType.Type;

export const AuthClientPresentationMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: Schema.optionalKey(AuthClientMetadataDeviceType),
  os: Schema.optionalKey(TrimmedNonEmptyString),
  osMajorVersion: Schema.optionalKey(Schema.Int),
  deviceModel: Schema.optionalKey(TrimmedNonEmptyString),
  surface: Schema.optionalKey(ClientSurface),
  webDeployment: Schema.optionalKey(ClientWebDeployment),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientPresentationMetadata = typeof AuthClientPresentationMetadata.Type;

export const AuthTokenExchangeRequest = Schema.Struct({
  grant_type: Schema.Literal(AuthTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString,
  subject_token_type: Schema.Literal(AuthEnvironmentBootstrapTokenType),
  requested_token_type: Schema.Literal(AuthAccessTokenType),
  scope: Schema.optionalKey(TrimmedNonEmptyString),
  client_label: Schema.optionalKey(TrimmedNonEmptyString),
  client_device_type: Schema.optionalKey(AuthClientMetadataDeviceType),
  client_os: Schema.optionalKey(TrimmedNonEmptyString),
  // T3-CUSTOM(expbkt3): identify stale client bundles in connection diagnostics.
  client_version: Schema.optionalKey(TrimmedNonEmptyString),
  identity_token: Schema.optionalKey(TrimmedNonEmptyString),
}).pipe(HttpApiSchema.asFormUrlEncoded());
export type AuthTokenExchangeRequest = typeof AuthTokenExchangeRequest.Type;

export const AuthAccessTokenResult = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(AuthAccessTokenType),
  token_type: Schema.Literals(["Bearer", "DPoP"]),
  expires_in: Schema.Number,
  scope: TrimmedNonEmptyString,
});
export type AuthAccessTokenResult = typeof AuthAccessTokenResult.Type;

export const AuthWebSocketTicketResult = Schema.Struct({
  ticket: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthWebSocketTicketResult = typeof AuthWebSocketTicketResult.Type;

export const AuthPairingCredentialResult = Schema.Struct({
  id: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingCredentialResult = typeof AuthPairingCredentialResult.Type;

// Read models contain metadata only. Credentials are returned by creation alone.
export const AuthPairingLink = Schema.Struct({
  id: TrimmedNonEmptyString,
  scopes: AuthEnvironmentScopes,
  subject: TrimmedNonEmptyString,
  label: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
});
export type AuthPairingLink = typeof AuthPairingLink.Type;

export const AuthClientMetadata = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  ipAddress: Schema.optionalKey(TrimmedNonEmptyString),
  userAgent: Schema.optionalKey(TrimmedNonEmptyString),
  deviceType: AuthClientMetadataDeviceType,
  os: Schema.optionalKey(TrimmedNonEmptyString),
  browser: Schema.optionalKey(TrimmedNonEmptyString),
  // T3-CUSTOM(expbkt3): persisted build identity for connected-client diagnostics.
  appVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type AuthClientMetadata = typeof AuthClientMetadata.Type;

export const AuthClientSession = Schema.Struct({
  sessionId: AuthSessionId,
  userId: Schema.NullOr(EnvironmentUserId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  subject: TrimmedNonEmptyString,
  scopes: AuthEnvironmentScopes,
  method: ServerAuthSessionMethod,
  client: AuthClientMetadata,
  issuedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastConnectedAt: Schema.NullOr(Schema.DateTimeUtc),
  connected: Schema.Boolean,
  current: Schema.Boolean,
});
export type AuthClientSession = typeof AuthClientSession.Type;

export const AuthAccessSnapshot = Schema.Struct({
  pairingLinks: Schema.Array(AuthPairingLink),
  clientSessions: Schema.Array(AuthClientSession),
});
export type AuthAccessSnapshot = typeof AuthAccessSnapshot.Type;

export const AuthAccessStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("snapshot"),
  payload: AuthAccessSnapshot,
});
export type AuthAccessStreamSnapshotEvent = typeof AuthAccessStreamSnapshotEvent.Type;

export const AuthAccessStreamPairingLinkUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkUpserted"),
  payload: AuthPairingLink,
});
export type AuthAccessStreamPairingLinkUpsertedEvent =
  typeof AuthAccessStreamPairingLinkUpsertedEvent.Type;

export const AuthAccessStreamPairingLinkRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("pairingLinkRemoved"),
  payload: Schema.Struct({
    id: TrimmedNonEmptyString,
  }),
});
export type AuthAccessStreamPairingLinkRemovedEvent =
  typeof AuthAccessStreamPairingLinkRemovedEvent.Type;

export class AuthAccessStreamError extends Schema.TaggedError<AuthAccessStreamError>()(
  "AuthAccessStreamError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentAuthorizationError extends Schema.TaggedError<EnvironmentAuthorizationError>()(
  "EnvironmentAuthorizationError",
  {
    message: Schema.String,
    requiredScope: AuthEnvironmentScope,
  },
) {}

export const AuthAccessStreamClientUpsertedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientUpserted"),
  payload: AuthClientSession,
});
export type AuthAccessStreamClientUpsertedEvent = typeof AuthAccessStreamClientUpsertedEvent.Type;

export const AuthAccessStreamClientRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Number,
  type: Schema.Literal("clientRemoved"),
  payload: Schema.Struct({
    sessionId: AuthSessionId,
  }),
});
export type AuthAccessStreamClientRemovedEvent = typeof AuthAccessStreamClientRemovedEvent.Type;

export const AuthAccessStreamEvent = Schema.Union([
  AuthAccessStreamSnapshotEvent,
  AuthAccessStreamPairingLinkUpsertedEvent,
  AuthAccessStreamPairingLinkRemovedEvent,
  AuthAccessStreamClientUpsertedEvent,
  AuthAccessStreamClientRemovedEvent,
]);
export type AuthAccessStreamEvent = typeof AuthAccessStreamEvent.Type;

export const AuthRevokePairingLinkInput = Schema.Struct({
  id: TrimmedNonEmptyString,
});
export type AuthRevokePairingLinkInput = typeof AuthRevokePairingLinkInput.Type;

export const AuthRevokeClientSessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type AuthRevokeClientSessionInput = typeof AuthRevokeClientSessionInput.Type;

export const AuthCreatePairingCredentialInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString),
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
  // T3-CUSTOM(expbkt3): BEGIN - mint a credential that can only be redeemed with a
  // DPoP proof, and that lives for 2 hours instead of 5 minutes. Off by default, so
  // every existing caller keeps producing exactly the credential it produces today.
  //
  // Safe to accept from a client, unlike a subject: it only *restricts* who can
  // redeem the credential and binds the issued token to the redeemer's key. There is
  // still deliberately no `subject` field — see apps/server/src/auth/OperatorIdentity.ts.
  requireProofOfPossession: Schema.optionalKey(Schema.Boolean),
  // T3-CUSTOM(expbkt3): END
});
export type AuthCreatePairingCredentialInput = typeof AuthCreatePairingCredentialInput.Type;

export const AuthSessionState = Schema.Struct({
  authenticated: Schema.Boolean,
  auth: ServerAuthDescriptor,
  scopes: Schema.optionalKey(AuthEnvironmentScopes),
  sessionMethod: Schema.optionalKey(ServerAuthSessionMethod),
  expiresAt: Schema.optionalKey(Schema.DateTimeUtc),
  // T3-CUSTOM(expbkt3): the acting operator, absent outside team mode. A client
  // with no ClerkProvider (the BK desktop, paired by credential) reads its own
  // identity back from here; see apps/server/src/auth/OperatorIdentity.ts.
  userId: Schema.optionalKey(UserId),
});
export type AuthSessionState = typeof AuthSessionState.Type;
