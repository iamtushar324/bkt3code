import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

// T3-CUSTOM(expbkt3): identity-only team mode composes inside the lazy Clerk boundary.
import {
  ManagedClerkIdentityAuthProvider,
  ManagedRelayAuthProvider,
} from "../../cloud/managedAuth";
import { resolveAppClerkMode } from "../../cloud/publicConfig";
import { TeamIdentityBridge } from "./TeamIdentityBridge";
// T3-CUSTOM(expbkt3): explain Clerk Native API stalls.
import { DesktopAuthStallNotice } from "./DesktopAuthStallNotice";
import { clerkAppearance } from "./clerkAppearance";

/**
 * Electron half of the managed-auth boundary. The Electron provider statically
 * bundles the full clerk-js runtime, so this module must only ever load
 * lazily, and only inside the desktop shell — importing it eagerly would put
 * clerk-js back into every client's startup graph.
 */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  // T3-CUSTOM(expbkt3): BEGIN — preserve managed desktop auth formatting markerability.
  return (
    // T3-CUSTOM(expbkt3): diagnose a stalled Native API independently of Clerk children.
    <>
      <ClerkProvider
        appearance={clerkAppearance}
        publishableKey={publishableKey}
        passkeys={passkeys}
      >
        <ManagedClerkIdentityAuthProvider>
          <TeamIdentityBridge />
          {resolveAppClerkMode() === "cloud" ? (
            <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
          ) : (
            children
          )}
        </ManagedClerkIdentityAuthProvider>
      </ClerkProvider>
      <DesktopAuthStallNotice />
    </>
  );
  // T3-CUSTOM(expbkt3): END
}
