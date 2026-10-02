/**
 * T3-CUSTOM(expbkt3): ToolyardAutoConnect - connects the built-in toolyard
 * integration once per app load.
 *
 * Mounted by `AppRoot` inside the atom registry (the Clerk shell wraps the
 * registry, so a Clerk-level component could not read the profile atom). It
 * waits until the operator is signed in and the personal MCP profile reports
 * no toolyard credential, then hands a fresh Clerk token to the server, which
 * does the exchange. Failures are quiet here; Settings → Experiments →
 * toolyard shows the state and offers Reconnect. The when/once rules live in
 * `createToolyardAutoConnectRunner`.
 *
 * A client without a Clerk publishable key — the keyless managed BK desktop,
 * which pairs by credential — can never mint the token, so it mounts nothing:
 * connecting is the web app's job, and the settings card says so.
 *
 * @module fork/toolyardAutoConnect
 */
import { useEffect } from "react";

import { hasClerkPublicConfig } from "../cloud/publicConfig";
import { usePersonalMcpProfile } from "../hooks/usePersonalMcpProfile";
import { useCurrentUserId } from "../state/identity";
import { readTeamClerkToken } from "../state/teamIdentityToken";
import { createToolyardAutoConnectRunner } from "./toolyardConnect";

// Per app load, not per mount: StrictMode and route changes must not turn one
// auto-connect into several, because every success rotates the token.
const runner = createToolyardAutoConnectRunner();

/** Exposed for tests that drive several loads in one process. */
export function resetToolyardAutoConnectForTests(): void {
  runner.reset();
}

export function ToolyardAutoConnect(): React.ReactElement | null {
  // Build-time constant, so the branch never changes between renders.
  if (!hasClerkPublicConfig()) return null;
  return <SignedInToolyardAutoConnect />;
}

function SignedInToolyardAutoConnect(): null {
  const userId = useCurrentUserId();
  const { profile, connectToolyard } = usePersonalMcpProfile();

  useEffect(() => {
    void runner.run({
      signedIn: userId !== null,
      userId,
      profile,
      readToken: readTeamClerkToken,
      connect: connectToolyard,
    });
  }, [connectToolyard, profile, userId]);

  return null;
}
