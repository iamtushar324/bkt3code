import { ClerkProvider } from "@clerk/react";
import type { ReactNode } from "react";

// T3-CUSTOM(expbkt3): identity-only team mode composes inside the lazy Clerk boundary.
import {
  ManagedClerkIdentityAuthProvider,
  ManagedRelayAuthProvider,
} from "../../cloud/managedAuth";
import { resolveAppClerkMode } from "../../cloud/publicConfig";
import { TeamIdentityBridge } from "./TeamIdentityBridge";
import { clerkAppearance } from "./clerkAppearance";

/** Lazy-load Clerk so cloudless local mode never downloads it. */
export default function BrowserManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  // T3-CUSTOM(expbkt3): BEGIN — preserve managed identity shell formatting markerability.
  return (
    // T3-CUSTOM(expbkt3): preserve standalone identity inside the lazy runtime.
    <ClerkProvider appearance={clerkAppearance} publishableKey={publishableKey}>
      <ManagedClerkIdentityAuthProvider>
        <TeamIdentityBridge />
        {resolveAppClerkMode() === "cloud" ? (
          <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
        ) : (
          children
        )}
      </ManagedClerkIdentityAuthProvider>
    </ClerkProvider>
  );
  // T3-CUSTOM(expbkt3): END
}
