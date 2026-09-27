/**
 * TeamIdentityBridge - mirror the signed-in Clerk user into the identity atom.
 *
 * Rendered inside ClerkProvider (team mode only). It writes the current Clerk
 * `userId` into `currentClerkUserAtom` so the rest of the app can read the
 * operator identity without depending on Clerk hooks. Pattern mirrors
 * `ManagedRelayAuthProvider`. Renders nothing.
 *
 * It also publishes `getToken` through `state/teamIdentityToken`, so the connection
 * layer can present the operator's identity when pairing a remote environment.
 *
 * @module components/clerk/TeamIdentityBridge
 */
import { useAuth } from "@clerk/react";
import { useEffect } from "react";

import type { UserId } from "@t3tools/contracts";
import { setCurrentClerkUser } from "../../state/identity";
// T3-CUSTOM(expbkt3): publish the team Clerk token for remote pairing.
import { setTeamClerkTokenProvider } from "../../state/teamIdentityToken";

export function TeamIdentityBridge(): null {
  const { isLoaded, isSignedIn, userId, getToken } = useAuth({ treatPendingAsSignedOut: false });

  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    setCurrentClerkUser(isSignedIn && userId ? (userId as UserId) : null);
  }, [isLoaded, isSignedIn, userId]);

  // T3-CUSTOM(expbkt3): BEGIN — mirrors `managedAuth.tsx`. Register the provider
  // rather than a token: Clerk session tokens are short-lived, so pairing must mint
  // a fresh one at the moment it exchanges.
  useEffect(() => {
    if (!isLoaded) {
      return;
    }
    setTeamClerkTokenProvider(isSignedIn ? () => getToken() : null);
  }, [isLoaded, isSignedIn, getToken]);
  // T3-CUSTOM(expbkt3): END

  useEffect(
    () => () => {
      setCurrentClerkUser(null);
      // T3-CUSTOM(expbkt3): drop the token provider with the bridge.
      setTeamClerkTokenProvider(null);
    },
    [],
  );

  return null;
}
