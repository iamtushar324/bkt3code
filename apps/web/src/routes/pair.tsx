import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

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
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  // T3-CUSTOM(expbkt3): team mode — when the server advertises a Clerk descriptor
  // and a publishable key is configured, use the Clerk gate instead of the
  // pairing-token surface. Reads the descriptor rather than a fork-only
  // `bootstrapMethods` entry, which stock clients cannot decode.
  if (serverAuthDescriptorSupportsTeam(authGateState.auth) && hasClerkPublicConfig()) {
    return (
      <ClerkSignInGate
        onAuthenticated={() => {
          void navigate({ to: afterAuthentication(), replace: true });
        }}
      />
    );
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        void navigate({ to: afterAuthentication(), replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
