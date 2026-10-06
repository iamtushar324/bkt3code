import type {
  AuthBrowserSessionResult,
  AuthClientMetadata,
  AuthEnvironmentScope,
  AuthPairingCredentialResult,
  ServerAuthSessionMethod,
  AuthSessionId,
  AuthSessionState,
} from "@t3tools/contracts";
import { EnvironmentHttpCommonError, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import type { EnvironmentHttpCommonError as EnvironmentHttpCommonErrorType } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): retained for the pairing-link/client-session listings above.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";

import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";

import { PrimaryEnvironmentHttpClient } from "./httpClient";
import { runPrimaryHttp } from "../../lib/runtime";
import { readManagedClerkIdentityToken } from "../../cloud/managedIdentity"; // T3-CUSTOM(expbkt3): managed Clerk identity binding, used below.
// T3-CUSTOM(expbkt3): identify the direct hosted build in server diagnostics.
import { APP_VERSION } from "../../branding";
// T3-CUSTOM(expbkt3): a managed BK build pairs with a central server by token exchange.
import { isBkManagedPrimary } from "../../fork/managedEnvironment";
import { resolveManagedOfflineAuthGateState } from "../../fork/managedOfflineGate";
import { clearManagedPrimaryAccessToken } from "../../fork/managedPrimaryCredential";
import { pairManagedPrimaryEnvironment } from "../../fork/managedPrimaryPairing";

const PrimaryEnvironmentRequestOperation = Schema.Literals([
  "fetch-session-state",
  // T3-CUSTOM(expbkt3): Web logout revokes the current environment session.
  "logout-current-session",
  "exchange-bootstrap-credential",
  "exchange-clerk-session",
  "bind-current-identity",
  "fetch-environment-descriptor",
  "create-pairing-credential",
  "list-pairing-links",
  "revoke-pairing-link",
  "list-client-sessions",
  "revoke-client-session",
  "revoke-other-client-sessions",
]);
type PrimaryEnvironmentRequestOperation = typeof PrimaryEnvironmentRequestOperation.Type;

export class PrimaryEnvironmentRequestError extends Schema.TaggedError<PrimaryEnvironmentRequestError>()(
  "PrimaryEnvironmentRequestError",
  {
    operation: PrimaryEnvironmentRequestOperation,
    status: Schema.Number,
    pairingLinkId: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(input: {
    readonly operation: PrimaryEnvironmentRequestOperation;
    readonly cause: unknown;
    readonly pairingLinkId?: string;
    readonly sessionId?: string;
  }): PrimaryEnvironmentRequestError {
    const status = readHttpApiStatus(input.cause) ?? 500;
    return new PrimaryEnvironmentRequestError({
      operation: input.operation,
      status,
      ...(input.pairingLinkId !== undefined ? { pairingLinkId: input.pairingLinkId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      cause: input.cause,
    });
  }

  override get message(): string {
    return `Primary environment request failed during ${this.operation} (HTTP ${this.status}).`;
  }
}

const isPrimaryEnvironmentRequestError = Schema.is(PrimaryEnvironmentRequestError);

export class PrimaryEnvironmentPairingCredentialRejectedError extends Schema.TaggedError<PrimaryEnvironmentPairingCredentialRejectedError>()(
  "PrimaryEnvironmentPairingCredentialRejectedError",
  {
    providedLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid pairing token. Check the token and try again.";
  }
}

export const isPrimaryEnvironmentPairingCredentialRejectedError = Schema.is(
  PrimaryEnvironmentPairingCredentialRejectedError,
);

export class PrimaryEnvironmentAuthSessionTimeoutError extends Schema.TaggedError<PrimaryEnvironmentAuthSessionTimeoutError>()(
  "PrimaryEnvironmentAuthSessionTimeoutError",
  {
    timeoutMs: Schema.Number,
    elapsedMs: Schema.Number,
  },
) {
  override get message(): string {
    return "Timed out waiting for authenticated session after bootstrap.";
  }
}

export class PrimaryEnvironmentPairingCredentialRequiredError extends Schema.TaggedError<PrimaryEnvironmentPairingCredentialRequiredError>()(
  "PrimaryEnvironmentPairingCredentialRequiredError",
  {
    providedLength: Schema.Number,
  },
) {
  override get message(): string {
    return "Enter a pairing token to continue.";
  }
}

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly userId: string | null; // T3-CUSTOM(expbkt3): member self-service device listing needs the owning user.
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

type ServerAuthGateState =
  | { status: "authenticated" }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);
  if (next.toString() === url.toString()) {
    return;
  }
  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

function getDesktopBootstrapCredential(): string | null {
  // T3-CUSTOM(expbkt3): a managed BK build's primary is a remote central server. The
  // local backend's bootstrap token is worthless there and must not be sent to it,
  // so the operator pairs explicitly instead.
  if (isBkManagedPrimary()) {
    return null;
  }
  // Both backends share the same bootstrap token (DesktopBackendConfiguration
  // mints one tokenRef and feeds it to both resolvers), so picking the
  // primary entry is fine even when the WSL backend is also registered.
  const bootstraps = window.desktopBridge?.getLocalEnvironmentBootstraps() ?? [];
  const primary = bootstraps.find((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
  return typeof primary?.bootstrapToken === "string" && primary.bootstrapToken.length > 0
    ? primary.bootstrapToken
    : null;
}

export async function fetchSessionState(): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    try {
      return await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) => client.auth.session({ headers: {} })),
        ),
      );
    } catch (error) {
      throw PrimaryEnvironmentRequestError.fromCause({
        operation: "fetch-session-state",
        cause: error,
      });
    }
  });
}

// T3-CUSTOM(expbkt3): BEGIN — terminate the server cookie session before Clerk signs out.
export async function logoutPrimaryEnvironment(): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.logout({ headers: {} })),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "logout-current-session",
      cause: error,
    });
  }

  // T3-CUSTOM(expbkt3): drop the paired bearer token too, or the next request would
  // re-present a credential the server has just revoked.
  clearManagedPrimaryAccessToken();
  resolvedAuthenticatedGateState = null;
  bootstrapPromise = null;
}
// T3-CUSTOM(expbkt3): END

function readHttpApiStatus(error: unknown): number | null {
  if (isEnvironmentHttpCommonError(error)) {
    return readEnvironmentHttpErrorStatus(error);
  }
  return HttpClientError.isHttpClientError(error) && error.response !== undefined
    ? error.response.status
    : null;
}

function readEnvironmentHttpErrorStatus(error: EnvironmentHttpCommonErrorType): number {
  switch (error._tag) {
    case "EnvironmentRequestInvalidError":
      return 400;
    case "EnvironmentAuthInvalidError":
      return 401;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return 403;
    case "EnvironmentResourceNotFoundError":
      return 404;
    case "EnvironmentInternalError":
      return 500;
  }
}

async function exchangeBootstrapCredential(credential: string): Promise<AuthBrowserSessionResult> {
  return retryTransientBootstrap(async () => {
    try {
      // T3-CUSTOM(expbkt3): a managed BK build is not same-origin with its primary and
      // sends `credentials: "omit"`, so a session cookie would never come back. Pair by
      // OAuth token exchange and keep the bearer token instead.
      if (isBkManagedPrimary()) {
        return await pairManagedPrimaryEnvironment(credential);
      }
      const identityToken = await readManagedClerkIdentityToken();
      return await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.auth.browserSession({
              payload: {
                credential,
                client_version: APP_VERSION,
                ...(identityToken ? { identityToken } : {}),
              },
            }),
          ),
        ),
      );
    } catch (error) {
      if (
        isEnvironmentHttpCommonError(error) &&
        error._tag === "EnvironmentAuthInvalidError" &&
        error.reason === "invalid_credential"
      ) {
        throw new PrimaryEnvironmentPairingCredentialRejectedError({
          providedLength: credential.length,
          cause: error,
        });
      }
      throw PrimaryEnvironmentRequestError.fromCause({
        operation: "exchange-bootstrap-credential",
        cause: error,
      });
    }
  });
}

/**
 * A valid Clerk token for someone outside the configured organization — the
 * gate surfaces this distinctly ("not a member — try a different account").
 */
export class PrimaryEnvironmentClerkNotMemberError extends Schema.TaggedError<PrimaryEnvironmentClerkNotMemberError>()(
  "PrimaryEnvironmentClerkNotMemberError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

async function exchangeClerkSession(token: string): Promise<AuthBrowserSessionResult> {
  try {
    return await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.clerkSession({ payload: { token, client_version: APP_VERSION } }),
        ),
      ),
    );
  } catch (error) {
    // Non-org-member ⇒ 403 forbidden; distinguish from a retryable failure.
    if (
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { _tag?: unknown })._tag === "EnvironmentHttpForbiddenError"
    ) {
      const detail =
        "message" in error && typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "This account is not a member of the workspace organization.";
      throw new PrimaryEnvironmentClerkNotMemberError({ detail });
    }
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "exchange-clerk-session",
      cause: error,
    });
  }
}

export async function bindPrimaryEnvironmentClerkIdentity(identityToken: string): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.bindIdentity({
            headers: {},
            payload: { identityToken },
          }),
        ),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "bind-current-identity",
      cause: error,
    });
  }
}

/**
 * Exchange a verified Clerk session token for a browser-session cookie, then
 * clear the auth gate caches so the app re-resolves as authenticated.
 */
export async function submitClerkSessionToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new PrimaryEnvironmentClerkNotMemberError({ detail: "Missing Clerk session token." });
  }
  resolvedAuthenticatedGateState = null;
  await exchangeClerkSession(trimmed);
  await waitForAuthenticatedSessionAfterBootstrap();
  bootstrapPromise = null;
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();

  while (true) {
    const session = await fetchSessionState();
    if (session.authenticated) {
      return session;
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      throw new PrimaryEnvironmentAuthSessionTimeoutError({
        timeoutMs: AUTH_SESSION_ESTABLISH_TIMEOUT_MS,
        elapsedMs,
      });
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientBootstrapError(error: unknown): boolean {
  if (isPrimaryEnvironmentRequestError(error)) {
    return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(urlCredential: string | null): Promise<ServerAuthGateState> {
  // T3-CUSTOM(expbkt3): BEGIN — a managed build must keep working offline. When
  // the central primary is unreachable at the transport level and this device
  // holds a still-valid pairing token, render the app instead of an error
  // screen; the connection supervisor owns the primary's retry state, and the
  // bundled local backend stays usable. See fork/managedOfflineGate.
  let currentSession: AuthSessionState;
  try {
    currentSession = await fetchSessionState();
  } catch (error) {
    const offlineState = await resolveManagedOfflineAuthGateState(error);
    if (offlineState !== null) {
      return offlineState;
    }
    throw error;
  }
  // T3-CUSTOM(expbkt3): END
  if (currentSession.authenticated && !urlCredential) {
    // T3-CUSTOM(expbkt3): BEGIN bind the existing session to the signed-in Clerk user.
    const identityToken = await readManagedClerkIdentityToken();
    if (identityToken) {
      try {
        await bindPrimaryEnvironmentClerkIdentity(identityToken);
      } catch (error) {
        // T3-CUSTOM(expbkt3): Recover through the Clerk sign-in exchange instead of
        // crashing the root route when a stale or incompatible identity token is rejected.
        return {
          status: "requires-auth",
          auth: currentSession.auth,
          errorMessage: error instanceof Error ? error.message : "Authentication failed.",
        };
      }
    }
    // T3-CUSTOM(expbkt3): END
    return { status: "authenticated" };
  }

  const bootstrapCredential = urlCredential ?? getDesktopBootstrapCredential();
  if (!bootstrapCredential) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
    };
  }

  try {
    await exchangeBootstrapCredential(bootstrapCredential);
    await waitForAuthenticatedSessionAfterBootstrap();
    return { status: "authenticated" };
  } catch (error) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new PrimaryEnvironmentPairingCredentialRequiredError({
      providedLength: credential.length,
    });
  }

  resolvedAuthenticatedGateState = null;
  await exchangeBootstrapCredential(trimmedCredential);
  await waitForAuthenticatedSessionAfterBootstrap();
  resolvedAuthenticatedGateState = { status: "authenticated" };
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

export async function createServerPairingCredential(input?: {
  readonly label?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  // T3-CUSTOM(expbkt3): mint a device-bound credential for a managed BK desktop.
  readonly requireProofOfPossession?: boolean;
}): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = input?.label?.trim();
  try {
    return await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.pairingCredential({
            headers: {},
            payload: {
              ...(trimmedLabel ? { label: trimmedLabel } : {}),
              ...(input?.scopes ? { scopes: input.scopes } : {}),
              // T3-CUSTOM(expbkt3): omitted unless asked for, so the request body is
              // unchanged for every existing caller.
              ...(input?.requireProofOfPossession ? { requireProofOfPossession: true } : {}),
            },
          }),
        ),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "create-pairing-credential",
      cause: error,
    });
  }
}

// T3-CUSTOM(expbkt3): BEGIN — upstream dropped this as unused (#10225); the fork's
// member-devices settings section still lists pairing links.
export async function listServerPairingLinks(): Promise<ReadonlyArray<ServerPairingLinkRecord>> {
  try {
    const pairingLinks = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.pairingLinks({ headers: {} })),
      ),
    );
    return pairingLinks.map((pairingLink) => {
      const timestamps = {
        createdAt: DateTime.formatIso(pairingLink.createdAt),
        expiresAt: DateTime.formatIso(pairingLink.expiresAt),
      };
      if (pairingLink.label === undefined) {
        return {
          id: pairingLink.id,
          scopes: pairingLink.scopes,
          subject: pairingLink.subject,
          createdAt: timestamps.createdAt,
          expiresAt: timestamps.expiresAt,
        };
      }
      return {
        id: pairingLink.id,
        scopes: pairingLink.scopes,
        subject: pairingLink.subject,
        label: pairingLink.label,
        createdAt: timestamps.createdAt,
        expiresAt: timestamps.expiresAt,
      };
    });
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "list-pairing-links",
      cause: error,
    });
  }
}
// T3-CUSTOM(expbkt3): END

export async function revokeServerPairingLink(id: string): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.revokePairingLink({ headers: {}, payload: { id } })),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-pairing-link",
      pairingLinkId: id,
      cause: error,
    });
  }
}

// T3-CUSTOM(expbkt3): BEGIN — upstream dropped this as unused (#10225); the fork's
// member-devices settings section still lists client sessions.
export async function listServerClientSessions(): Promise<
  ReadonlyArray<ServerClientSessionRecord>
> {
  try {
    const clientSessions = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.clients({ headers: {} })),
      ),
    );
    return clientSessions.map((clientSession) => ({
      sessionId: clientSession.sessionId,
      userId: clientSession.userId,
      subject: clientSession.subject,
      scopes: clientSession.scopes,
      method: clientSession.method,
      client: clientSession.client,
      issuedAt: DateTime.formatIso(clientSession.issuedAt),
      expiresAt: DateTime.formatIso(clientSession.expiresAt),
      lastConnectedAt:
        clientSession.lastConnectedAt === null
          ? null
          : DateTime.formatIso(clientSession.lastConnectedAt),
      connected: clientSession.connected,
      current: clientSession.current,
    }));
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "list-client-sessions",
      cause: error,
    });
  }
}
// T3-CUSTOM(expbkt3): END

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  try {
    await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) =>
          client.auth.revokeClient({ headers: {}, payload: { sessionId } }),
        ),
      ),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-client-session",
      sessionId,
      cause: error,
    });
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  try {
    const result = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.auth.revokeOtherClients({ headers: {} })),
      ),
    );
    return result.revokedCount;
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-other-client-sessions",
      cause: error,
    });
  }
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  const urlCredential = takePairingTokenFromUrl();
  const previousPromise = bootstrapPromise;
  if (urlCredential) {
    resolvedAuthenticatedGateState = null;
  } else {
    if (previousPromise) {
      return previousPromise;
    }

    if (resolvedAuthenticatedGateState?.status === "authenticated") {
      return resolvedAuthenticatedGateState;
    }
  }

  const nextPromise = previousPromise
    ? previousPromise
        .catch(() => undefined)
        .then(() => {
          resolvedAuthenticatedGateState = null;
          return bootstrapServerAuth(urlCredential);
        })
    : bootstrapServerAuth(urlCredential);
  bootstrapPromise = nextPromise;
  return nextPromise
    .then((result) => {
      if (bootstrapPromise === nextPromise && result.status === "authenticated") {
        resolvedAuthenticatedGateState = result;
      }
      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}
