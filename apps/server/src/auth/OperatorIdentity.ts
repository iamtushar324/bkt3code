/**
 * T3-CUSTOM(expbkt3): who is acting on an authenticated environment request.
 *
 * Two fork behaviours share one derivation, so they share one module:
 *
 * 1. A pairing credential minted by a signed-in operator carries *that
 *    operator* as its subject (`clerk:<userId>`) instead of the anonymous
 *    `one-time-token` default. Everything downstream already reads the subject
 *    — `AccessControl.actorFor` turns it into the acting user — so a client
 *    paired with that credential simply *is* the operator, with no changes to
 *    authorization.
 *
 * 2. `/api/auth/session` reports the same derived user id, so a client with no
 *    ClerkProvider (the BK desktop, paired by credential) can read back its own
 *    identity and render the team-mode affordances.
 *
 * **Security constraint: the subject is derived from the authenticated session
 * only.** `AuthCreatePairingCredentialInput` deliberately has no `subject`
 * field, so no client — not even an admin one — can mint a credential that
 * impersonates a teammate. This module is the seam that lets the HTTP handler
 * reach the subject-aware issue path without widening that public payload.
 *
 * @module auth/OperatorIdentity
 */
import type {
  AuthEnvironmentScope,
  AuthPairingCredentialResult,
  EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import { UserId, clerkSubjectForUser, userIdFromSubject } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as EnvironmentAuth from "./EnvironmentAuth.ts";

/**
 * Subject used by upstream for a pairing credential with no operator behind it
 * (CLI startup pairing, single-user local servers).
 */
export const ANONYMOUS_PAIRING_SUBJECT = "one-time-token";

/** The principal fields identity is derived from. */
export type OperatorPrincipal = Pick<EnvironmentSessionPrincipalShape, "subject" | "userId">;

/**
 * The acting user for a session, or `null` when the session is not an operator
 * (pairing, CLI, desktop bootstrap ⇒ unrestricted local mode).
 *
 * Mirrors `orchestration/Layers/AccessControl.ts#actorFor` exactly: a durable
 * binding wins, otherwise the subject is decoded. Keep the two in step — a
 * disagreement would let the UI render as one user while authorization runs as
 * another.
 */
export function operatorUserIdForPrincipal(principal: OperatorPrincipal): UserId | null {
  if (principal.userId !== null) {
    return UserId.make(principal.userId);
  }
  return userIdFromSubject(principal.subject);
}

/**
 * The `userId` fields to spread into an authenticated `AuthSessionState`.
 *
 * Spread-shaped so the upstream literal it lands in keeps its exact formatting:
 * one added line, one conflict to resolve on a merge instead of a reshaped
 * block.
 */
export function operatorSessionStateFields(
  principal: OperatorPrincipal,
): { readonly userId: UserId } | Record<string, never> {
  const userId = operatorUserIdForPrincipal(principal);
  return userId === null ? {} : { userId };
}

/**
 * Subject to stamp on a pairing credential created by this principal. Falls
 * back to upstream's anonymous subject when there is no operator, so
 * single-user servers keep issuing exactly the credentials they issue today.
 */
export function pairingSubjectForPrincipal(principal: OperatorPrincipal): string {
  const userId = operatorUserIdForPrincipal(principal);
  return userId === null ? ANONYMOUS_PAIRING_SUBJECT : clerkSubjectForUser(userId);
}

/**
 * How long a proof-of-possession pairing credential lives.
 *
 * Ordinary pairing codes keep `DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES` (5 minutes) in
 * `PairingGrantStore`. A credential redeemable only with a DPoP proof gets a longer
 * window because installing and pairing a desktop app is not a 5-minute task, and
 * the token it produces is bound to the redeeming device's key rather than being a
 * bearer secret. The two go together: never widen this TTL without the binding.
 */
export const PROOF_OF_POSSESSION_PAIRING_TTL = Duration.hours(2);

/**
 * Issue a pairing credential on behalf of the authenticated operator.
 *
 * Deliberately takes the *principal* rather than a subject: the caller cannot
 * pass a subject through, which is what keeps the impersonation hole closed.
 * Scopes are still the caller's (the handler has already checked the requested
 * scopes are a subset of the operator's own).
 */
export const issuePairingCredentialForPrincipal = Effect.fn(
  "expbkt3.auth.issuePairingCredentialForPrincipal",
)(function* (input: {
  readonly serverAuth: Pick<EnvironmentAuth.EnvironmentAuth["Service"], "createPairingLink">;
  readonly principal: OperatorPrincipal;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label?: string;
  /**
   * Mint a device-bound credential: redeemable only with a DPoP proof, and valid
   * for {@link PROOF_OF_POSSESSION_PAIRING_TTL}. Set by the operator when pairing a
   * managed BK desktop; every other caller leaves it off and is unaffected.
   */
  readonly requireProofOfPossession?: boolean;
  /**
   * Minted by a member for one of their own devices rather than by an
   * environment administrator: caps the member's concurrent pairings and
   * shortens the session it produces. See `SelfServicePairing.ts`.
   */
  readonly selfIssued?: boolean;
}) {
  const issued = yield* input.serverAuth.createPairingLink({
    scopes: input.scopes,
    subject: pairingSubjectForPrincipal(input.principal),
    ...(input.label ? { label: input.label } : {}),
    ...(input.requireProofOfPossession
      ? { requiresProofOfPossession: true, ttl: PROOF_OF_POSSESSION_PAIRING_TTL }
      : {}),
    ...(input.selfIssued ? { selfIssued: true } : {}),
  });
  return {
    id: issued.id,
    credential: issued.credential,
    ...(issued.label ? { label: issued.label } : {}),
    expiresAt: issued.expiresAt,
  } satisfies AuthPairingCredentialResult;
});
