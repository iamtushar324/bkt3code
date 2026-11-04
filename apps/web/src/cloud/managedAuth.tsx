// T3-CUSTOM(expbkt3): useAuth drives the fork managed Clerk identity provider below.
import { useAuth, useClerk } from "@clerk/react";
import {
  createCloudAccountService,
  ManagedRelay,
  setManagedRelaySession,
} from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"; // T3-CUSTOM(expbkt3): useState and useSyncExternalStore power the managed-auth readiness gates below.

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
// T3-CUSTOM(expbkt3): managed Clerk identity binding for environment sessions.
import { setManagedClerkIdentityTokenProvider } from "./managedIdentity";

// T3-CUSTOM(expbkt3): BEGIN managed Clerk identity provider for environment auth.
export function ManagedClerkIdentityAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const [ready, setReady] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the external Clerk token provider before children render
  useEffect(() => {
    if (!isLoaded) {
      // oxlint-disable-next-line react/set-state-in-effect -- children render only once the external token provider is registered, which happens in this commit.
      setReady(false);
      return;
    }

    setManagedClerkIdentityTokenProvider(isSignedIn ? () => getToken() : null);
    setReady(true);
  }, [getToken, isLoaded, isSignedIn]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the external Clerk token provider on unmount
  useEffect(() => () => setManagedClerkIdentityTokenProvider(null), []);

  return ready ? children : null;
}
// T3-CUSTOM(expbkt3): END managed Clerk identity provider.

export function deactivateManagedRelayAuthentication(): void {
  // T3-CUSTOM(expbkt3): clear the managed Clerk identity provider with the relay session.
  setManagedClerkIdentityTokenProvider(null);
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  // T3-CUSTOM(expbkt3): share the relay Clerk token with environment identity binding.
  setManagedClerkIdentityTokenProvider(readClerkToken);
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

type ClerkInstance = ReturnType<typeof useClerk>;

function clerkTokenReader(clerk: ClerkInstance): () => Promise<string | null> {
  return async () =>
    clerk.session ? await clerk.session.getToken(resolveRelayClerkTokenOptions()) : null;
}

// T3-CUSTOM(expbkt3): BEGIN managed relay readiness gate. Children stay hidden
// until the account service settles (signed out, or the account is active), so
// they never see a flash of signed-out state, including while accounts switch.
const managedRelayReadinessListeners = new Set<() => void>();
function notifyManagedRelayReadiness(): void {
  for (const listener of managedRelayReadinessListeners) listener();
}
function subscribeManagedRelayReadiness(listener: () => void): () => void {
  managedRelayReadinessListeners.add(listener);
  return () => managedRelayReadinessListeners.delete(listener);
}
function readManagedRelayReadiness(): boolean {
  const tag = managedRelayAccountService.getState()._tag;
  return tag === "SignedOut" || tag === "Active";
}
// T3-CUSTOM(expbkt3): END managed relay readiness gate.

const managedRelayAccountService = createCloudAccountService<ClerkInstance>({
  // T3-CUSTOM(expbkt3): BEGIN notify the readiness gate on every account step.
  deactivate: () => {
    deactivateManagedRelayAuthentication();
    notifyManagedRelayReadiness();
  },
  detach: () => {
    deactivateManagedRelayAuthentication();
    notifyManagedRelayReadiness();
  },
  // T3-CUSTOM(expbkt3): END notify the readiness gate on every account step.
  cleanUp: async () => {
    const results = await Promise.all([
      runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
        reportFailure: false,
        reportDefect: false,
      }),
      settleAsyncResult(() =>
        runtime.runPromiseExit(
          ManagedRelay.ManagedRelayClient.pipe(Effect.flatMap((client) => client.resetTokenCache)),
        ),
      ),
    ]);
    for (const result of results) {
      reportAtomCommandResult(result, { label: "cloud account cleanup" });
    }
  },
  // T3-CUSTOM(expbkt3): activation also reveals children gated on relay auth.
  activate: ({ source, accountId }) => {
    activateManagedRelayAuthentication(accountId, clerkTokenReader(source));
    notifyManagedRelayReadiness(); // T3-CUSTOM(expbkt3): reveal children once managed relay auth is active.
  },
});

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  // ClerkProvider creates the Clerk instance and owns its lifetime, so the
  // account service observes it for as long as this provider is mounted.
  const clerk = useClerk();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- attaches the Clerk instance to the managed relay account service for the provider's lifetime
  useEffect(() => managedRelayAccountService.attach(clerk), [clerk]);
  // T3-CUSTOM(expbkt3): don't render children until managed relay auth settles.
  const ready = useSyncExternalStore(
    subscribeManagedRelayReadiness,
    readManagedRelayReadiness,
    readManagedRelayReadiness,
  );
  return ready ? children : null; // T3-CUSTOM(expbkt3)
}
