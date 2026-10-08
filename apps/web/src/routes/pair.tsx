import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
// T3-CUSTOM(expbkt3): team mode — Clerk-gated pairing route.
import { ClerkSignInGate } from "../components/auth/ClerkSignInGate";
import { hasClerkPublicConfig } from "../cloud/publicConfig";
// T3-CUSTOM(expbkt3): team-mode detection reads the server's clerk descriptor.
import { serverAuthDescriptorSupportsTeam } from "../fork/environmentTeamCapability";
// T3-CUSTOM(expbkt3): a pairing link wins over the Clerk gate.
import { isExplicitPairingRequested, peekPairingTokenFromUrl } from "../environments/primary";
import { resolvePairRouteSurface } from "../fork/pairRouteSurface";

// T3-CUSTOM(expbkt3): return to explicit Toolyard settings submission after browser authentication.
import { pendingToolyardSettingsContinuation } from "../fork/toolyardSettingsContinuation";
const afterAuthentication = () =>
  pendingToolyardSettingsContinuation() ? ("/settings/experiments" as const) : ("/" as const);

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (authGateState.status === "authenticated" || authGateState.status === "hosted-static") {
      // T3-CUSTOM(expbkt3): restore an explicit Toolyard draft after browser authentication.
      throw redirect({ to: afterAuthentication(), replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const router = useRouter();
  const { authGateState } = Route.useRouteContext();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  // T3-CUSTOM(expbkt3): team mode — when the server advertises a Clerk descriptor
  // and a publishable key is configured, use the Clerk gate instead of the
  // pairing-token surface, unless this visit carries a pairing link. Reads the
  // descriptor rather than a fork-only `bootstrapMethods` entry, which stock
  // clients cannot decode. After sign-in, reload like the pairing path so the
  // WebSocket uses the new cookie; the Toolyard draft lives in sessionStorage.
  if (
    resolvePairRouteSurface({
      teamMode: serverAuthDescriptorSupportsTeam(authGateState.auth) && hasClerkPublicConfig(),
      hasPairingToken: peekPairingTokenFromUrl() !== null,
      explicitPairingRequested: isExplicitPairingRequested(),
    }) === "clerk"
  ) {
    return (
      <ClerkSignInGate
        onAuthenticated={() => {
          router.history.replace(afterAuthentication());
          router.history.flush();
          window.location.reload();
        }}
      />
    );
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        // Recreate the primary connection so its WebSocket and cached scopes
        // use the newly issued cookie after re-pairing.
        // T3-CUSTOM(expbkt3): restore an explicit Toolyard draft after pairing authentication.
        router.history.replace(afterAuthentication());
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
