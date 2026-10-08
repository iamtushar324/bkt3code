import {
  authScopeRequiredResponse,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthGrantScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError, // T3-CUSTOM(expbkt3): 403 for a verified non-member Clerk token.
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  // T3-CUSTOM(expbkt3): self-service pairing refusals widen this union.
  type EnvironmentOperationForbiddenReason,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope, DpopFailureReason } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): decode the operator a pairing grant's subject names.
import { EnvironmentUserId, userIdFromSubject } from "@t3tools/contracts";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { resolveClerkBrowserIdentity } from "./ClerkBrowserIdentity.ts";
// T3-CUSTOM(expbkt3): direct-vs-relay identity policy for the token exchange.
import { resolveExchangeIdentity } from "./ExchangeIdentity.ts";
import { isEnvironmentIdentityRequired } from "./mcpApprovalPolicy.expbkt3.ts"; // T3-CUSTOM(expbkt3)
// T3-CUSTOM(expbkt3): the pairing grant can name the operator when no token does.
import * as PairingGrantStore from "./PairingGrantStore.ts";
// T3-CUSTOM(expbkt3): BEGIN - pairing credentials carry the operator that created
// them, and members may mint one for their own devices without `access:write`.
import {
  issuePairingCredentialForPrincipal,
  operatorUserIdForPrincipal,
} from "./OperatorIdentity.ts";
import {
  canIssueSelfServicePairing,
  isSelfServiceScopeAllowed,
  ownClientSessions,
  ownPairingLinks,
  selfServicePairingScopes,
} from "./SelfServicePairing.ts";
// T3-CUSTOM(expbkt3): END
import { ClerkDirectory } from "./ClerkDirectory.ts";
import * as ClerkIdentityVerifier from "./ClerkIdentityVerifier.ts";
import * as EnvironmentUserService from "./EnvironmentUserService.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSettings from "../serverSettings.ts"; // T3-CUSTOM(expbkt3): environment user identity mode.
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(
  reason: EnvironmentAuthInvalidReason,
  dpopFailureReason?: DpopFailureReason,
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason,
          ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          ...authScopeRequiredResponse(requiredScope),
          traceId,
        }),
      ),
    ),
  );
}

// T3-CUSTOM(expbkt3): BEGIN - the self-service pairing path admits a session that
// carries a Clerk identity instead of `access:write`, and narrows what it may see and
// do to that member's own devices. Returns the principal plus which of the two routes
// admitted it, so each handler can keep the administrative behaviour untouched.
export const requireEnvironmentScopeOrOwnIdentity = Effect.fn(
  "environment.auth.requireScopeOrOwnIdentity",
)(function* (scope: AuthEnvironmentScope) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (session.scopes.has(scope)) {
    return { session, administrative: true as const };
  }
  if (operatorUserIdForPrincipal(session) === null) {
    // No identity and no scope: unchanged 403, same as upstream.
    return yield* failEnvironmentScopeRequired(scope);
  }
  return { session, administrative: false as const };
});
// T3-CUSTOM(expbkt3): END

function failEnvironmentOperationForbidden(
  // T3-CUSTOM(expbkt3): self-service pairing refusals reuse this 403.
  reason: EnvironmentOperationForbiddenReason,
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

/**
 * `<img>` and WebSocket cannot set headers, so media routes (device hub,
 * preview stream) authenticate the way the `/ws` upgrade does: a cookie for browser
 * sessions, or a short-lived `wsTicket` minted over authenticated HTTP for
 * bearer and DPoP clients. The upgrade authenticator already implements that
 * fallback order, so it is used for plain requests as well.
 */
export const authenticateMediaRequest = (requiredScope: AuthEnvironmentScope) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
    return session;
  });

export function failEnvironmentInternal(reason: EnvironmentInternalErrorReason, error?: unknown) {
  return Effect.gen(function* () {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({ code: "internal_error", reason, traceId });
  });
}

const appendSessionCookie = (cookieName: string, token: string, expiresAt: DateTime.DateTime) =>
  Effect.fromResult(
    Cookies.set(Cookies.empty, cookieName, token, {
      expires: DateTime.toDate(expiresAt),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
    }),
  ).pipe(
    Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")),
    Effect.flatMap((cookies) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
      ),
    ),
  );

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const startTime = yield* Clock.currentTimeNanos;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const endTime = yield* Clock.currentTimeNanos;
        const handler = httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
        );
        return yield* session.subject === "cloud-connect"
          ? traceAuthenticatedRelayRequest(handler, { startTime, endTime })
          : handler;
      }).pipe(Effect.catchTags({ EnvironmentAuthInvalidError: appendDpopChallengeOnUnauthorized }));
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    // T3-CUSTOM(expbkt3): read a grant's subject without consuming it; see below.
    const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
    const sessions = yield* SessionStore.SessionStore;
    const clerkDirectory = yield* ClerkDirectory;
    const clerkIdentity = yield* ClerkIdentityVerifier.ClerkIdentityVerifier;
    const users = yield* EnvironmentUserService.EnvironmentUserService;
    const settings = yield* ServerSettings.ServerSettingsService;

    const resolveIdentity = (
      token: string | undefined,
    ): Effect.Effect<
      ClerkIdentityVerifier.VerifiedClerkIdentity | null,
      EnvironmentAuthInvalidError | EnvironmentInternalError
    > =>
      Effect.gen(function* () {
        const identityMode = yield* settings.getSettings.pipe(
          Effect.map((current) => current.environmentUserIdentityMode),
          Effect.catch((error) => failEnvironmentInternal("identity_management_failed", error)),
        );
        if (!token) {
          // T3-CUSTOM(expbkt3): one rule for pairing exchanges and MCP agent approvals.
          return isEnvironmentIdentityRequired(identityMode)
            ? yield* failEnvironmentAuthInvalid("missing_identity")
            : null;
        }
        const identity = yield* clerkIdentity.verify(token).pipe(
          Effect.catchTags({
            EnvironmentUserManagementError: (error) =>
              Effect.gen(function* () {
                return error.reason === "identity-not-configured"
                  ? yield* failEnvironmentInternal("identity_management_failed", error)
                  : yield* failEnvironmentAuthInvalid("invalid_identity");
              }),
          }),
        );
        yield* users.assertAllowed(identity.userId).pipe(
          Effect.catchTags({
            EnvironmentUserManagementError: (error) =>
              Effect.gen(function* () {
                return error.reason === "identity-blocked"
                  ? yield* failEnvironmentAuthInvalid("blocked_identity")
                  : yield* failEnvironmentInternal("identity_management_failed", error);
              }),
          }),
        );
        return identity;
      }).pipe(Effect.withSpan("environment.auth.resolveIdentity"));

    const persistIdentity = Effect.fn("environment.auth.persistIdentity")(function* (
      identity: ClerkIdentityVerifier.VerifiedClerkIdentity | null,
      administrativeGrant: boolean,
    ) {
      if (identity === null) return;
      yield* users.admit(identity, { administrativeGrant }).pipe(
        Effect.catchTags({
          EnvironmentUserManagementError: (error) =>
            failEnvironmentInternal("identity_management_failed", error),
        }),
      );
    });

    // T3-CUSTOM(expbkt3): Browser tokens are ordinary Clerk session tokens. They must be
    // verified with the Clerk secret + org membership, not the relay JWT audience verifier.
    const resolveDirectClerkIdentity = (token: string) =>
      resolveClerkBrowserIdentity(token).pipe(
        Effect.provideService(ClerkDirectory, clerkDirectory),
        Effect.catchTags({
          ClerkDirectoryError: (error) =>
            failEnvironmentInternal("identity_management_failed", error),
        }),
        Effect.tap(({ identity }) =>
          users.assertAllowed(identity.userId).pipe(
            Effect.catchTags({
              EnvironmentUserManagementError: (error) =>
                Effect.gen(function* () {
                  return error.reason === "identity-blocked"
                    ? yield* failEnvironmentAuthInvalid("blocked_identity")
                    : yield* failEnvironmentInternal("identity_management_failed", error);
                }),
            }),
          ),
        ),
      );

    // T3-CUSTOM(expbkt3): BEGIN — identity for the `/oauth/token` exchange. Policy
    // and its rationale live in `ExchangeIdentity.ts`; this binds it to the two
    // verifiers already built above.
    //
    // A verified non-member fails as `invalid_identity` rather than the 403 that
    // `clerkSession` returns: this endpoint's declared error union has no forbidden
    // member, and widening it would ripple through every remote client's error type.
    //
    // A client that presents no `identity_token` — the Clerk-free BK desktop — can
    // still be identified by the credential it is redeeming, because a member-minted
    // credential carries `clerk:<userId>` as a subject the *server* derived. Reading
    // it here, without consuming the grant, is what lets such a client satisfy
    // `environmentUserIdentityMode: "required"`. An anonymous grant still resolves to
    // nothing and is refused exactly as before.
    const resolveGrantIdentity = (credential: string) =>
      Effect.gen(function* () {
        const subject = yield* pairingGrants
          .peekSubject(credential)
          .pipe(
            Effect.catchIf(PairingGrantStore.isBootstrapCredentialInternalError, (error) =>
              failEnvironmentInternal("identity_management_failed", error),
            ),
          );
        const userId = subject === null ? null : userIdFromSubject(subject);
        if (userId === null) {
          return null;
        }
        // A member who has since been blocked must not be able to pair, even with a
        // credential minted while they were allowed.
        yield* users.assertAllowed(EnvironmentUserId.make(userId)).pipe(
          Effect.catchTags({
            EnvironmentUserManagementError: (error) =>
              Effect.gen(function* () {
                return error.reason === "identity-blocked"
                  ? yield* failEnvironmentAuthInvalid("blocked_identity")
                  : yield* failEnvironmentInternal("identity_management_failed", error);
              }),
          }),
        );
        return {
          userId: EnvironmentUserId.make(userId),
          displayName: null,
          primaryEmail: null,
          avatarUrl: null,
        } satisfies ClerkIdentityVerifier.VerifiedClerkIdentity;
      });

    const resolveTokenExchangeIdentity = (input: {
      readonly token: string | undefined;
      readonly credential: string;
    }) =>
      resolveExchangeIdentity({
        token: input.token,
        verifyDirect: resolveDirectClerkIdentity,
        verifyRelayAudience: resolveIdentity,
        onNotOrgMember: () => failEnvironmentAuthInvalid("invalid_identity"),
        resolveGrantIdentity: () => resolveGrantIdentity(input.credential),
      });
    // T3-CUSTOM(expbkt3): END

    // T3-CUSTOM(expbkt3): BEGIN — revoke the caller and expire its HttpOnly browser cookie.
    const logoutHandler = Effect.fn("environment.auth.logout")(
      function* () {
        yield* annotateEnvironmentRequest("logout");
        const session = yield* EnvironmentAuthenticatedPrincipal;
        const revoked = yield* serverAuth.revokeSession(session.sessionId);

        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(
            HttpServerResponse.expireCookieUnsafe(response, sessions.cookieName, {
              httpOnly: true,
              path: "/",
              sameSite: "lax",
            }),
          ),
        );
        yield* appendCredentialResponseHeaders;
        return { revoked };
      },
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("client_session_revoke_failed", error),
      ),
    );
    // T3-CUSTOM(expbkt3): END

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.getSessionState(request);
            const credential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            if (
              credential?.source === "legacy-cookie" &&
              result.authenticated &&
              result.sessionMethod === "browser-session-cookie" &&
              result.expiresAt
            ) {
              yield* appendSessionCookie(sessions.cookieName, credential.token, result.expiresAt);
              yield* appendCredentialResponseHeaders;
            }
            return result;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle("logout", logoutHandler) // T3-CUSTOM(expbkt3): Server-backed web logout.
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const identity = yield* resolveIdentity(args.payload.identityToken); // T3-CUSTOM(expbkt3): team mode identity resolution.
            const previousCredential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              // T3-CUSTOM(expbkt3): direct hosted clients also report their build.
              deriveAuthClientMetadata({
                request,
                ...(args.payload.client_version
                  ? { presented: { appVersion: args.payload.client_version } }
                  : {}),
              }),
              previousCredential?.source === "cookie" ||
                previousCredential?.source === "legacy-cookie"
                ? previousCredential.token
                : undefined,
              identity ? { userId: identity.userId } : undefined, // T3-CUSTOM(expbkt3): bind the team user.
            );
            yield* persistIdentity(
              identity,
              result.response.scopes.includes(AuthAccessWriteScope),
            ).pipe(
              Effect.tapError(() =>
                sessions.verify(result.sessionToken).pipe(
                  Effect.flatMap((session) => sessions.revoke(session.sessionId)),
                  Effect.ignore,
                ),
              ),
            );
            const cookieName = result.cookieName ?? sessions.cookieName;
            const selectedCookie = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
            const sessionCookies = result.expireNormalCookie
              ? yield* Effect.fromResult(
                  Cookies.expireCookie(selectedCookie, sessions.cookieName, {
                    httpOnly: true,
                    path: "/",
                    sameSite: "lax",
                  }),
                ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")))
              : selectedCookie;

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      ) // T3-CUSTOM(expbkt3): BEGIN — team mode: direct Clerk sign-in mints a browser cookie for an already-verified operator.
      .handle(
        "clerkSession",
        Effect.fn("environment.auth.clerkSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            // Verify the Clerk token and hard-gate on org membership before
            // minting a browser-session cookie bound to "clerk:<userId>".
            const verified = yield* resolveDirectClerkIdentity(args.payload.token);
            yield* persistIdentity(verified.identity, verified.administrativeGrant);
            const result = yield* serverAuth.createClerkBrowserSession(
              { subject: verified.subject, userId: verified.identity.userId },
              deriveAuthClientMetadata({
                request,
                ...(args.payload.client_version
                  ? { presented: { appVersion: args.payload.client_version } }
                  : {}),
              }),
            );
            const sessionCookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          // A valid token for a non-member (or Clerk disabled) is forbidden;
          // a bad/expired token is auth_invalid.
          Effect.catchTags({
            ClerkAuthError: (
              error,
            ): Effect.Effect<never, EnvironmentAuthInvalidError | EnvironmentHttpForbiddenError> =>
              error.reason === "invalid_token"
                ? failEnvironmentAuthInvalid("invalid_credential")
                : Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "bindIdentity",
        Effect.fn("environment.auth.bindIdentity")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            // T3-CUSTOM(expbkt3): END
            // T3-CUSTOM(expbkt3): This endpoint receives the direct browser session token.
            const verified = yield* resolveDirectClerkIdentity(args.payload.identityToken);
            const identity = verified.identity;
            yield* persistIdentity(
              identity,
              verified.administrativeGrant || session.scopes.has(AuthAccessWriteScope),
            );
            yield* sessions
              .bindUserId(session.sessionId, identity.userId)
              .pipe(
                Effect.catchIf(SessionStore.isSessionCredentialInternalError, (error) =>
                  failEnvironmentInternal("identity_management_failed", error),
                ),
              );
            yield* appendCredentialResponseHeaders;
            return { userId: identity.userId };
          },
          Effect.catchTags({
            ClerkAuthError: () => failEnvironmentAuthInvalid("invalid_identity"),
          }),
          Effect.catchTags({ EnvironmentAuthInvalidError: appendDpopChallengeOnUnauthorized }),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : (parseOAuthScope(args.payload.scope)?.filter(Schema.is(AuthGrantScope)) ?? null);
            if (requestedScopes === null || requestedScopes?.length === 0) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(
                        failEnvironmentAuthInvalid(
                          "invalid_credential",
                          EnvironmentAuth.serverAuthDpopFailureReason(error),
                        ),
                      ),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            // T3-CUSTOM(expbkt3): accept a direct Clerk browser token here too, so a
            // remote client can pair against `environmentUserIdentityMode: "required"`.
            const { identity, administrativeGrant, identitySource } =
              yield* resolveTokenExchangeIdentity({
                token: args.payload.identity_token,
                // T3-CUSTOM(expbkt3): the grant is the fallback source of identity.
                credential: args.payload.subject_token,
              });
            yield* appendCredentialResponseHeaders;
            const result = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                  // T3-CUSTOM(expbkt3): persist client build identity for diagnostics.
                  ...(args.payload.client_version
                    ? { appVersion: args.payload.client_version }
                    : {}),
                },
              }),
              proofKeyThumbprint || identity
                ? {
                    ...(proofKeyThumbprint ? { proofKeyThumbprint } : {}),
                    ...(identity ? { userId: identity.userId } : {}),
                  }
                : undefined,
            );
            yield* persistIdentity(
              // T3-CUSTOM(expbkt3): a grant-derived identity carries no Clerk profile,
              // so it is bound to the session but never fed to directory admission —
              // admitting it would overwrite a real record with blanks. The operator was
              // already admitted when they signed in to mint the credential.
              identitySource === "pairing-grant" ? null : identity,
              // T3-CUSTOM(expbkt3): a Clerk org admin is admitted as an environment
              // admin, matching `bindIdentity`.
              administrativeGrant || result.scope.split(" ").includes(AuthAccessWriteScope),
            ).pipe(
              Effect.tapError(() =>
                sessions.verify(result.access_token).pipe(
                  Effect.flatMap((session) => sessions.revoke(session.sessionId)),
                  Effect.ignore,
                ),
              ),
            );
            return result;
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // T3-CUSTOM(expbkt3): a member with a Clerk identity may mint for themselves;
            // `access:write` still gates every environment-wide credential.
            const { session, administrative } =
              yield* requireEnvironmentScopeOrOwnIdentity(AuthAccessWriteScope);
            const delegatedScopes =
              args.payload.scopes ??
              // T3-CUSTOM(expbkt3): a member's default is their own standard scopes.
              (administrative
                ? AuthStandardClientScopes
                : selfServicePairingScopes(session.scopes));
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            // T3-CUSTOM(expbkt3): BEGIN - self-service guards. Scopes are narrowed to the
            // standard client set so a self-issued credential can never carry `access:*`
            // or `relay:write`, and the member's concurrent pairings are capped.
            if (!administrative) {
              if (!isSelfServiceScopeAllowed(delegatedScopes, session.scopes)) {
                return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
              }
              const selfUserId = operatorUserIdForPrincipal(session);
              if (selfUserId === null) {
                return yield* failEnvironmentScopeRequired(AuthAccessWriteScope);
              }
              const [pairingLinks, clientSessions] = yield* Effect.all([
                serverAuth.listPairingLinks(),
                serverAuth.listClientSessions(session.sessionId),
              ]);
              if (
                !canIssueSelfServicePairing({ userId: selfUserId, pairingLinks, clientSessions })
              ) {
                return yield* failEnvironmentOperationForbidden("self_pairing_limit_reached");
              }
            }
            // T3-CUSTOM(expbkt3): END
            // T3-CUSTOM(expbkt3): stamp the authenticated operator on the credential
            // so a client paired with it acts as them. The subject comes from the
            // session, never from the payload — `AuthCreatePairingCredentialInput`
            // has no `subject` field, so no client can mint one for a teammate.
            return yield* issuePairingCredentialForPrincipal({
              serverAuth,
              principal: session,
              scopes: delegatedScopes,
              ...(args.payload.label ? { label: args.payload.label } : {}),
              // T3-CUSTOM(expbkt3): opt-in, default off — a device-bound credential for
              // a managed BK desktop. Only ever restricts redemption, so unlike a
              // subject it is safe to take from the payload.
              ...(args.payload.requireProofOfPossession ? { requireProofOfPossession: true } : {}),
              // T3-CUSTOM(expbkt3): marks the link as a member's own, which caps it and
              // shortens the session it produces. Administrative links are unaffected.
              ...(administrative ? {} : { selfIssued: true }),
            });
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // T3-CUSTOM(expbkt3): a member sees only their own links; `access:read`
            // still sees every link in the environment.
            const { session, administrative } =
              yield* requireEnvironmentScopeOrOwnIdentity(AuthAccessReadScope);
            const pairingLinks = yield* serverAuth.listPairingLinks();
            return administrative ? pairingLinks : ownPairingLinks(pairingLinks, session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_links_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // T3-CUSTOM(expbkt3): a member may revoke their own link; anything else
            // still needs `access:write`.
            const { session, administrative } =
              yield* requireEnvironmentScopeOrOwnIdentity(AuthAccessWriteScope);
            if (!administrative) {
              const own = ownPairingLinks(yield* serverAuth.listPairingLinks(), session);
              if (!own.some((pairingLink) => pairingLink.id === args.payload.id)) {
                return yield* failEnvironmentOperationForbidden("self_pairing_not_own_resource");
              }
            }
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // T3-CUSTOM(expbkt3): a member sees only their own sessions.
            const { session, administrative } =
              yield* requireEnvironmentScopeOrOwnIdentity(AuthAccessReadScope);
            const clientSessions = yield* serverAuth.listClientSessions(session.sessionId);
            return administrative ? clientSessions : ownClientSessions(clientSessions, session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_sessions_load_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            // T3-CUSTOM(expbkt3): a member may revoke their own device sessions.
            const { session, administrative } =
              yield* requireEnvironmentScopeOrOwnIdentity(AuthAccessWriteScope);
            if (!administrative) {
              const own = ownClientSessions(
                yield* serverAuth.listClientSessions(session.sessionId),
                session,
              );
              if (
                !own.some((clientSession) => clientSession.sessionId === args.payload.sessionId)
              ) {
                return yield* failEnvironmentOperationForbidden("self_pairing_not_own_resource");
              }
            }
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthForbiddenOperationError: () =>
              failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      );
  }),
);
