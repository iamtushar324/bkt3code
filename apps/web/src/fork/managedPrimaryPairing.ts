/**
 * T3-CUSTOM(expbkt3): pairing a managed BK build with its central server.
 *
 * Upstream's primary-environment pairing exchanges a credential for a browser
 * *session cookie*. That works because upstream's primary is either the page's
 * own origin or a loopback backend the desktop trusts. A managed BK build's
 * primary is a remote HTTPS server the renderer is not same-origin with, and
 * the desktop's primary HTTP layer deliberately sends `credentials: "omit"` —
 * so a cookie issued there would never be presented again.
 *
 * The same pairing credential works over the OAuth token-exchange endpoint the
 * remote/SSH environments already use. The exchange carries a DPoP proof, so the
 * server binds the token it issues to this device's key — which is what a
 * credential minted with `requireProofOfPossession` demands, and what makes its
 * 2-hour window safe. We keep that token (`fork/managedPrimaryCredential`) and
 * the primary seams present it, with a fresh proof, on every HTTP request and
 * WebSocket ticket.
 *
 * @module fork/managedPrimaryPairing
 */
import type { AuthBrowserSessionResult, AuthEnvironmentScope } from "@t3tools/contracts";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthEnvironmentScope as AuthEnvironmentScopeSchema,
  AuthTokenExchangeGrantType,
} from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { APP_VERSION } from "../branding";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { runPrimaryHttp } from "../lib/runtime";
import { writeManagedPrimaryAccessToken } from "./managedPrimaryCredential";
import { createManagedPrimaryDpopProof, loadManagedPrimaryDpopKey } from "./managedPrimaryDpop";

const ALLOWED_SCOPES: ReadonlySet<AuthEnvironmentScope> = new Set(
  AuthEnvironmentScopeSchema.literals,
);

/** Raised when this client cannot produce a device key, so pairing is impossible. */
export class ManagedPrimaryDpopKeyUnavailableError extends Error {
  constructor() {
    super(
      "This client could not create a device key, so it cannot pair with the managed environment.",
    );
    this.name = "ManagedPrimaryDpopKeyUnavailableError";
  }
}

/**
 * Exchange a pairing credential for a DPoP-bound session on the managed primary
 * environment and record it.
 *
 * Returns the same shape upstream's cookie exchange returns, so the auth gate's
 * success and error handling is untouched. Failures propagate unmapped: the
 * caller already turns an `invalid_credential` auth error into the
 * "Invalid pairing token" message — which is also what the server returns for a
 * device-bound credential redeemed without a proof.
 */
export async function pairManagedPrimaryEnvironment(
  credential: string,
): Promise<AuthBrowserSessionResult> {
  const proofKey = await loadManagedPrimaryDpopKey();
  if (proofKey === null) {
    throw new ManagedPrimaryDpopKeyUnavailableError();
  }
  const tokenUrl = resolvePrimaryEnvironmentHttpUrl("/oauth/token");
  const proof = await createManagedPrimaryDpopProof({ method: "POST", url: tokenUrl });
  if (proof === null) {
    throw new ManagedPrimaryDpopKeyUnavailableError();
  }

  const result = await runPrimaryHttp(
    PrimaryEnvironmentHttpClient.pipe(
      Effect.flatMap((client) =>
        client.auth.token({
          headers: { dpop: proof },
          payload: {
            grant_type: AuthTokenExchangeGrantType,
            subject_token: credential,
            subject_token_type: AuthEnvironmentBootstrapTokenType,
            requested_token_type: AuthAccessTokenType,
            client_device_type: "desktop",
            client_version: APP_VERSION,
          },
        }),
      ),
    ),
  );

  writeManagedPrimaryAccessToken({
    accessToken: result.access_token,
    expiresInSeconds: result.expires_in,
    dpopThumbprint: proofKey.thumbprint,
  });

  return {
    authenticated: true,
    scopes: parseAllowedOAuthScope({ value: result.scope, allowedScopes: ALLOWED_SCOPES }) ?? [],
    sessionMethod: result.token_type === "DPoP" ? "dpop-access-token" : "bearer-access-token",
    expiresAt: DateTime.makeUnsafe(Date.now() + result.expires_in * 1_000),
  };
}
