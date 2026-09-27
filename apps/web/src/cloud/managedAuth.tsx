import { useAuth } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
// T3-CUSTOM(expbkt3): managed Clerk identity binding for environment sessions.
import { setManagedClerkIdentityTokenProvider } from "./managedIdentity";

// T3-CUSTOM(expbkt3): BEGIN managed Clerk identity provider for environment auth.
export function ManagedClerkIdentityAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) {
      setReady(false);
      return;
    }

    setManagedClerkIdentityTokenProvider(isSignedIn ? () => getToken() : null);
    setReady(true);
  }, [getToken, isLoaded, isSignedIn]);

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

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isLoaded) {
      setReady(false);
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          removeRelayEnvironments(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateManagedRelayAuthentication();
      setReady(true);
      if (previousAccount !== null) {
        void queueAccountCleanup();
      }
    } else {
      const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
          setReady(true);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        setReady(false);
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);

  return ready ? children : null;
}
