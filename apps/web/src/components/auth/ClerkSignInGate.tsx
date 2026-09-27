/**
 * ClerkSignInGate - team-mode sign-in surface.
 *
 * Rendered by the /pair route (instead of PairingRouteSurface) when the server
 * advertises a `clerk` auth descriptor and a Clerk publishable key is
 * configured. Shows Clerk's prebuilt <SignIn/>; once the user is signed into
 * Clerk it exchanges the session token for a server browser-session cookie via
 * `submitClerkSessionToken`, then calls `onAuthenticated`. A valid token for a
 * non-org-member is rejected with a clear message + "Try a different account".
 * If the user is already signed into Clerk (e.g. the server cookie expired and
 * they bounced back to /pair) the exchange runs silently on mount.
 *
 * @module components/auth/ClerkSignInGate
 */
import { SignIn, useAuth } from "@clerk/react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { submitClerkSessionToken } from "../../environments/primary";
// T3-CUSTOM(expbkt3): send browser sign-in back to this environment. Without
// these props Clerk falls back to the instance's dashboard-configured
// after_sign_in_url, which for the Beknown instance is be-dash.beknown.live, so
// the operator never returns to /pair and no session exchange ever happens.
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "../clerk/authRedirect";

type GateStatus = "idle" | "exchanging" | "rejected" | "error";

export function ClerkSignInGate({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const { isLoaded, isSignedIn, getToken, signOut } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const [status, setStatus] = useState<GateStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) {
      return;
    }
    let cancelled = false;
    setStatus("exchanging");
    setMessage(null);
    void (async () => {
      try {
        const token = await getToken();
        if (!token) {
          throw new Error("Could not read a Clerk session token.");
        }
        await submitClerkSessionToken(token);
        if (!cancelled) {
          onAuthenticated();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          (error as { _tag?: unknown })._tag === "PrimaryEnvironmentClerkNotMemberError"
        ) {
          setStatus("rejected");
          setMessage(error instanceof Error ? error.message : String(error));
        } else {
          setStatus("error");
          setMessage(error instanceof Error ? error.message : "Sign-in failed.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, getToken, onAuthenticated]);

  return (
    <div className="flex min-h-dvh w-full items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-6">
        {!isLoaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !isSignedIn ? (
          // T3-CUSTOM(expbkt3): resolveClerkSignInProps returns {} on Electron,
          // where Clerk's native allowlist authorizes only the bare renderer root.
          <SignIn {...resolveClerkSignInProps(window.location.href, isElectron)} />
        ) : status === "rejected" ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <h1 className="text-lg font-semibold">Access denied</h1>
            <p className="text-sm text-muted-foreground">
              {message ?? "This account is not a member of the workspace organization."}
            </p>
            <p className="text-sm text-muted-foreground">
              Ask an admin to invite you, or sign in with a workspace account.
            </p>
            <Button variant="outline" onClick={() => void signOut()}>
              Try a different account
            </Button>
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <h1 className="text-lg font-semibold">Sign-in failed</h1>
            <p className="text-sm text-muted-foreground">{message ?? "Please try again."}</p>
            <Button variant="outline" onClick={() => void signOut()}>
              Sign out and retry
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Signing you in…</p>
        )}
      </div>
    </div>
  );
}
