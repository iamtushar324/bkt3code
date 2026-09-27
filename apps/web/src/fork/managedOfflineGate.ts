/**
 * T3-CUSTOM(expbkt3): offline-first auth gate for managed BK desktop builds.
 *
 * The root route blocks on one HTTP round-trip to the primary environment
 * (`fetchSessionState`). For upstream that primary is the local backend, so a
 * failure means the app itself is broken and an error screen is honest. For a
 * managed BK build the primary is a remote central server: with the network
 * down, or the server down, that same failure used to take out the whole
 * renderer — including the bundled *local* backend, which is exactly what a
 * user offline on a train still needs.
 *
 * The rule here: when the primary is the managed central server, a paired
 * device (a stored, unexpired, key-matched access token — the same check
 * every request uses) is treated as authenticated when the session probe
 * fails at the transport level. The per-environment connection supervisor
 * already owns the "primary disconnected, retrying" state from there, and the
 * bundled backend keeps working throughout.
 *
 * A revoked or expired token never takes this path: `/api/auth/session`
 * answers those with a *successful* `authenticated: false` response, which
 * still routes to the pairing gate. Only a thrown (network-level) failure
 * lands here, and with no stored token the failure propagates exactly as
 * before.
 *
 * @module fork/managedOfflineGate
 */
import { isBkManagedPrimary } from "./managedEnvironment";
import { readManagedPrimaryAccessToken } from "./managedPrimaryCredential";

/**
 * The decision, kept pure so the rule is testable without wiring the
 * credential store: enter the offline-authenticated state only for a managed
 * primary holding a presentable stored token.
 */
export function shouldEnterOfflineAuthenticatedState(input: {
  readonly managedPrimary: boolean;
  readonly storedAccessToken: string | null;
}): boolean {
  return input.managedPrimary && input.storedAccessToken !== null;
}

/**
 * The authenticated gate state to use when the primary session probe threw,
 * or null when the failure should propagate unchanged.
 */
export async function resolveManagedOfflineAuthGateState(
  cause: unknown,
): Promise<{ readonly status: "authenticated" } | null> {
  const managedPrimary = isBkManagedPrimary();
  const storedAccessToken = managedPrimary ? await readManagedPrimaryAccessToken() : null;
  if (!shouldEnterOfflineAuthenticatedState({ managedPrimary, storedAccessToken })) {
    return null;
  }
  console.warn("Managed primary environment is unreachable; continuing with local environments.", {
    cause,
  });
  return { status: "authenticated" };
}
