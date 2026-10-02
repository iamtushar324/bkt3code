/**
 * T3-CUSTOM(expbkt3): what "Log out" in Settings → Experiments does on each client.
 *
 * The settings sidebar's `WebLogoutControl` covers the browser only. This button
 * also works in the desktop app, where being signed in means a different thing
 * per build:
 *
 * - **Browser** (team mode): a server cookie session plus a Clerk session.
 *   Revoke the server session, end Clerk, then load `/pair` — the order
 *   `performWebLogout` already enforces, so a failed revocation never leaves a
 *   half-logged-out browser.
 * - **Managed BK desktop** (`isBkManagedPrimary`): keyless, so no ClerkProvider
 *   is mounted (docs/operations/bk-desktop-build.md, "Managed builds are
 *   keyless"). Its sign-in is the DPoP-bound access token its pairing produced.
 *   `logoutPrimaryEnvironment` revokes that session on the central server and
 *   drops the stored token; the window then reloads into the pairing screen,
 *   where the operator pastes a new pairing token.
 * - **Unmanaged desktop with a Clerk key**: the primary environment is the
 *   bundled backend, authenticated by a bearer token the Electron main process
 *   caches for the app's lifetime (`DesktopLocalEnvironmentAuth`). Revoking it
 *   would leave the window unauthenticated until the app restarts, so only
 *   Clerk is signed out before the window reloads.
 *
 * The desktop reloads rather than routing: the revoked session is still held by
 * open WebSocket connections and cached atoms, and the Electron Clerk provider
 * deliberately never reloads the renderer on its own.
 *
 * @module fork/experimentsLogout
 */
import { performWebLogout } from "../components/clerk/WebLogoutControl";

export type ExperimentsLogoutDestination = "browser-pairing" | "desktop-pairing" | "desktop-reload";

export interface ExperimentsLogoutPlan {
  /** Revoke the primary environment session (a managed desktop also drops its token). */
  readonly revokeEnvironmentSession: boolean;
  readonly signOutClerk: boolean;
  /** Where the window goes once both steps succeeded. */
  readonly destination: ExperimentsLogoutDestination;
}

/** The logout this client supports, or null when there is nothing to log out of. */
export function resolveExperimentsLogoutPlan(input: {
  readonly isElectron: boolean;
  readonly managedPrimary: boolean;
  readonly clerkSignedIn: boolean;
}): ExperimentsLogoutPlan | null {
  if (!input.isElectron) {
    return input.clerkSignedIn
      ? { revokeEnvironmentSession: true, signOutClerk: true, destination: "browser-pairing" }
      : null;
  }
  if (input.managedPrimary) {
    return {
      revokeEnvironmentSession: true,
      signOutClerk: input.clerkSignedIn,
      destination: "desktop-pairing",
    };
  }
  return input.clerkSignedIn
    ? { revokeEnvironmentSession: false, signOutClerk: true, destination: "desktop-reload" }
    : null;
}

export interface ExperimentsLogoutEffects {
  readonly logoutEnvironment: () => Promise<void>;
  readonly signOutClerk: () => Promise<unknown>;
  readonly navigate: (destination: ExperimentsLogoutDestination) => void;
}

const skip = async (): Promise<void> => undefined;

/** Runs a plan's steps in `performWebLogout`'s order, skipping the ones it leaves out. */
export function performExperimentsLogout(
  plan: ExperimentsLogoutPlan,
  effects: ExperimentsLogoutEffects,
): Promise<void> {
  return performWebLogout({
    logoutEnvironment: plan.revokeEnvironmentSession ? effects.logoutEnvironment : skip,
    signOutClerk: plan.signOutClerk ? effects.signOutClerk : skip,
    redirectToSignIn: () => effects.navigate(plan.destination),
  });
}

/**
 * One logout at a time, so a double click cannot revoke twice or race two
 * navigations. `run` returns null when a logout is already in flight. A failure
 * re-arms the guard so the user can retry; a success leaves it closed, because
 * the window is already navigating away.
 */
export function createLogoutRunner() {
  let inFlight = false;
  return {
    run(perform: () => Promise<void>, onError: (error: unknown) => void): Promise<void> | null {
      if (inFlight) return null;
      inFlight = true;
      return Promise.resolve()
        .then(perform)
        .catch((error: unknown) => {
          inFlight = false;
          onError(error);
        });
    },
  };
}

/** The desktop renderer's hash-routed pairing screen, on the current renderer URL. */
export function desktopPairingHref(href: string): string {
  const url = new URL(href);
  url.hash = "/pair";
  return url.toString();
}

export function navigateAfterLogout(
  destination: ExperimentsLogoutDestination,
  location: Pick<Location, "href" | "assign" | "reload">,
  history: Pick<History, "state" | "replaceState">,
): void {
  switch (destination) {
    case "browser-pairing":
      location.assign(new URL("/pair", location.href).toString());
      return;
    case "desktop-pairing":
      // Setting `location.hash` would route in place; rewrite the URL silently and
      // reload so the app boots fresh at the pairing screen.
      history.replaceState(history.state, "", desktopPairingHref(location.href));
      location.reload();
      return;
    case "desktop-reload":
      location.reload();
      return;
  }
}
