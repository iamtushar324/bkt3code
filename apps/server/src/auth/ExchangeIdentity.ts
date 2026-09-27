/**
 * T3-CUSTOM(expbkt3): ExchangeIdentity - which Clerk verifier `/oauth/token` uses.
 *
 * Two kinds of client present an `identity_token` at the token exchange, and they
 * carry different JWTs:
 *
 * - a client pairing directly with this environment sends an ordinary Clerk browser
 *   session token, which only verifies against the Clerk secret (`ClerkDirectory`);
 * - relay-brokered and mobile clients send the relay-audience identity JWT, which
 *   verifies through `ClerkIdentityVerifier` (JWKS + audience `t3-code-relay`).
 *
 * Neither verifier accepts the other's token, so the exchange tries the direct one
 * and falls back. The order matters: falling back on a *rejected* token is what
 * keeps every pre-existing client working unchanged, while a verified non-member
 * must not fall through to a second chance.
 *
 * A third kind of client presents no `identity_token` at all: the BK desktop, which
 * pairs with a credential and never mounts Clerk. On an environment configured with
 * `environmentUserIdentityMode: "required"` that used to be rejected as
 * `missing_identity` before the pairing grant was ever consulted — which defeated
 * identity-bearing credentials at exactly the gate they exist to pass, because a
 * member-minted credential already carries `clerk:<userId>` as its server-derived
 * subject. So the missing-identity decision is deferred: the environment's own rule
 * runs first, and only if it objects do we ask whether the grant itself names an
 * operator.
 *
 * The policy lives here, apart from the HTTP wiring, because it is the whole of the
 * fork's behavior at this seam and needs to stay covered across upstream merges.
 *
 * @module auth/ExchangeIdentity
 */
import type { EnvironmentAuthInvalidError, EnvironmentInternalError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ClerkAuthError } from "./ClerkDirectory.ts";
import type { VerifiedClerkBrowserIdentity } from "./ClerkBrowserIdentity.ts";
import type { VerifiedClerkIdentity } from "./ClerkIdentityVerifier.ts";

/** The failures `/oauth/token` may already report while resolving an identity. */
export type ExchangeIdentityError = EnvironmentAuthInvalidError | EnvironmentInternalError;

export interface ExchangeIdentityResolution {
  /** The operator to bind to the session, or `null` for an unidentified exchange. */
  readonly identity: VerifiedClerkIdentity | null;
  /** True when Clerk reports the operator as an organization admin. */
  readonly administrativeGrant: boolean;
  /**
   * Where the identity came from.
   *
   * `"pairing-grant"` means it was read off the credential's server-minted subject
   * rather than verified from a token this request carried. It is good enough to
   * bind to the session — a client cannot choose a subject — but it carries no
   * Clerk profile, so the caller must not feed it to the directory admission path
   * and blank out a real record.
   */
  readonly identitySource: "token" | "pairing-grant";
}

/** Whether an error is the environment's "you must present an identity" rule. */
export const isMissingIdentityError = (error: ExchangeIdentityError): boolean =>
  error._tag === "EnvironmentAuthInvalidError" && error.reason === "missing_identity";

/**
 * Resolve the identity for a token exchange.
 *
 * `verifyRelayAudience` owns the no-token case, because that is where the
 * environment's `environmentUserIdentityMode` rule lives — it decides whether an
 * absent identity is acceptable or a `missing_identity` rejection.
 */
export const resolveExchangeIdentity = (input: {
  readonly token: string | undefined;
  readonly verifyDirect: (
    token: string,
  ) => Effect.Effect<VerifiedClerkBrowserIdentity, ClerkAuthError | ExchangeIdentityError>;
  readonly verifyRelayAudience: (
    token: string | undefined,
  ) => Effect.Effect<VerifiedClerkIdentity | null, ExchangeIdentityError>;
  readonly onNotOrgMember: () => Effect.Effect<never, ExchangeIdentityError>;
  /**
   * The operator named by the pairing grant being redeemed, if any. Consulted only
   * when no `identity_token` was presented *and* the environment rejected that, so
   * an environment with identity optional keeps resolving exactly as before.
   */
  readonly resolveGrantIdentity: () => Effect.Effect<
    VerifiedClerkIdentity | null,
    ExchangeIdentityError
  >;
}): Effect.Effect<ExchangeIdentityResolution, ExchangeIdentityError> => {
  const viaRelayAudience = (
    token: string | undefined,
  ): Effect.Effect<ExchangeIdentityResolution, ExchangeIdentityError> =>
    input.verifyRelayAudience(token).pipe(
      Effect.map((identity) => ({
        identity,
        administrativeGrant: false,
        identitySource: "token" as const,
      })),
    );

  const token = input.token;
  if (token === undefined) {
    // The environment rule runs first and unchanged. Only a `missing_identity`
    // refusal is reconsidered, and only in favour of an operator the *server* put
    // on the credential — so this can admit nobody a client could name.
    return viaRelayAudience(token).pipe(
      Effect.catchIf(isMissingIdentityError, (missingIdentity) =>
        input.resolveGrantIdentity().pipe(
          Effect.flatMap((identity) =>
            identity === null
              ? Effect.fail(missingIdentity)
              : Effect.succeed({
                  identity,
                  administrativeGrant: false,
                  identitySource: "pairing-grant" as const,
                } satisfies ExchangeIdentityResolution),
          ),
        ),
      ),
    );
  }

  return input.verifyDirect(token).pipe(
    Effect.map((verified): ExchangeIdentityResolution => ({
      identity: verified.identity,
      administrativeGrant: verified.administrativeGrant,
      identitySource: "token",
    })),
    Effect.catchTag("ClerkAuthError", (error) =>
      // A verified identity that is simply outside the organization is a decision,
      // not a failed guess at the token format. Retrying it against the other
      // verifier would either fail confusingly or, worse, admit someone the org
      // gate just turned away.
      error.reason === "not_org_member" ? input.onNotOrgMember() : viaRelayAudience(token),
    ),
  );
};
