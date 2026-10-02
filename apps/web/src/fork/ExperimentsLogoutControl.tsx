/**
 * T3-CUSTOM(expbkt3): the "Log out" row in Settings → Experiments, on web and desktop.
 *
 * Clerk hooks run only below `hasClerkPublicConfig()`: `main.tsx` mounts a
 * ClerkProvider (browser or Electron) exactly when a publishable key is
 * configured, so that check keeps every hook inside a provider. The hooks come
 * from `@clerk/react` on both platforms — `@clerk/electron/react` re-exports that
 * same module, and importing it here would pull clerk-js into the browser bundle.
 * A managed BK desktop is keyless and signs in by pairing instead, so it gets its
 * own Clerk-free branch. What each path does is in `fork/experimentsLogout`.
 *
 * @module fork/ExperimentsLogoutControl
 */
import { useAuth, useUser } from "@clerk/react";
import { LoaderCircleIcon, LogOutIcon } from "lucide-react";
import { useState } from "react";

import { hasClerkPublicConfig } from "../cloud/publicConfig";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useCurrentUserId } from "../state/identity";
import { useOrgMembers } from "../state/orgMembers";
import {
  createLogoutRunner,
  endPrimaryEnvironmentSession,
  navigateAfterLogout,
  performExperimentsLogout,
  resolveExperimentsLogoutPlan,
  resolveExperimentsLogoutSource,
  type ExperimentsLogoutPlan,
} from "./experimentsLogout";
import { isBkManagedPrimary } from "./managedEnvironment";

export function ExperimentsLogoutControl() {
  const source = resolveExperimentsLogoutSource({
    hasClerkConfig: hasClerkPublicConfig(),
    isElectron,
    managedPrimary: isBkManagedPrimary(),
  });
  if (source === "clerk") return <ClerkAccountLogout />;
  if (source === "paired-session") return <PairedDesktopLogout />;
  return null;
}

function ClerkAccountLogout() {
  const { isLoaded, isSignedIn, signOut } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const plan = resolveExperimentsLogoutPlan({
    isElectron,
    managedPrimary: isBkManagedPrimary(),
    clerkSignedIn: isLoaded && isSignedIn === true,
  });
  if (plan === null) return null;

  return (
    <ExperimentsLogoutSection
      plan={plan}
      account={user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? null}
      signOutClerk={() => signOut()}
    />
  );
}

/** A keyless managed desktop: the operator is whoever the paired session reports. */
function PairedDesktopLogout() {
  const userId = useCurrentUserId();
  const { resolveUser } = useOrgMembers();
  const member = userId === null ? null : resolveUser(userId);
  const plan = resolveExperimentsLogoutPlan({
    isElectron: true,
    managedPrimary: true,
    clerkSignedIn: false,
  });
  if (plan === null) return null;

  return <ExperimentsLogoutSection plan={plan} account={member?.email ?? member?.name ?? null} />;
}

const noClerkSession = async (): Promise<void> => undefined;

function ExperimentsLogoutSection({
  plan,
  account,
  signOutClerk = noClerkSession,
}: {
  readonly plan: ExperimentsLogoutPlan;
  readonly account: string | null;
  readonly signOutClerk?: () => Promise<unknown>;
}) {
  const [runner] = useState(createLogoutRunner);
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const handleLogout = () => {
    const started = runner.run(
      () =>
        performExperimentsLogout(plan, {
          logoutEnvironment: () => endPrimaryEnvironmentSession(),
          signOutClerk,
          navigate: (destination) =>
            navigateAfterLogout(destination, window.location, window.history),
        }),
      (error) => {
        setIsLoggingOut(false);
        toastManager.add({
          type: "error",
          title: "Could not log out",
          description: error instanceof Error ? error.message : "Please try again.",
        });
      },
    );
    if (started !== null) setIsLoggingOut(true);
  };

  return (
    <SettingsSection title="Account">
      <SettingsRow
        title="Log out"
        description={describeLogout(plan, account)}
        control={
          <Button size="sm" variant="outline" disabled={isLoggingOut} onClick={handleLogout}>
            {isLoggingOut ? <LoaderCircleIcon className="animate-spin" /> : <LogOutIcon />}
            {isLoggingOut ? "Logging out…" : "Log out"}
          </Button>
        }
      />
    </SettingsSection>
  );
}

function describeLogout(plan: ExperimentsLogoutPlan, account: string | null): string {
  const signedInAs = account ? `Signed in as ${account}. ` : "";
  switch (plan.destination) {
    case "browser-pairing":
      return `${signedInAs}Ends this browser's session and signs you out, then returns to the sign-in page.`;
    case "desktop-pairing":
      return `${signedInAs}Ends this app's session on the central server and forgets this device's pairing. To sign back in, paste a new pairing token.`;
    case "desktop-reload":
      return `${signedInAs}Signs this app out of your account. The backend on this computer stays connected.`;
  }
}
