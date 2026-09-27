/**
 * T3-CUSTOM(expbkt3): teamIdentityToken - the operator's Clerk session token,
 * readable outside React.
 *
 * `TeamIdentityBridge` registers the provider while a team-mode `ClerkProvider` is
 * mounted, so non-React code — notably the connection layer, which pairs remote
 * environments from an Effect service — can mint a fresh token without a hook.
 *
 * Deliberately separate from `cloud/managedIdentity.ts`, whose token belongs to the
 * T3 Connect relay and is issued by a different Clerk instance. A fork environment
 * verifies this one against its own Clerk secret; the two are not interchangeable.
 *
 * @module state/teamIdentityToken
 */

let teamClerkTokenProvider: (() => Promise<string | null>) | null = null;

export function setTeamClerkTokenProvider(provider: (() => Promise<string | null>) | null): void {
  teamClerkTokenProvider = provider;
}

/**
 * A fresh Clerk session token for the signed-in operator, or `null` outside team
 * mode, while signed out, or when Clerk cannot issue one. Never throws — pairing
 * treats a missing token as "no identity to present" and lets the environment
 * decide whether that is acceptable.
 */
export async function readTeamClerkToken(): Promise<string | null> {
  if (teamClerkTokenProvider === null) return null;
  try {
    return await teamClerkTokenProvider();
  } catch {
    return null;
  }
}
