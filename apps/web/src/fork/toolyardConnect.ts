/**
 * T3-CUSTOM(expbkt3): toolyardConnect - what the client knows about the
 * built-in toolyard integration.
 *
 * The server owns the connection (it exchanges the Clerk token and keeps the
 * toolyard token); the client only decides *when* to ask for one and how to
 * word the answer. Both decisions live here, free of React, so they are
 * testable without rendering.
 *
 * @module fork/toolyardConnect
 */
import {
  type PersonalMcpIntegration,
  type PersonalMcpProfile,
  TOOLYARD_MCP_INTEGRATION_ID,
} from "@t3tools/contracts";

/** The built-in toolyard integration of a profile; the server always presents one. */
export function toolyardIntegrationOf(
  profile: PersonalMcpProfile | null | undefined,
): PersonalMcpIntegration | null {
  return (
    profile?.integrations.find((integration) => integration.id === TOOLYARD_MCP_INTEGRATION_ID) ??
    null
  );
}

/**
 * Whether this app load should connect toolyard on the user's behalf: only a
 * signed-in operator (there is no Clerk token otherwise), only once the
 * profile has loaded and shows no toolyard credential, and at most once per
 * app load. A failed attempt waits for the next load rather than retrying.
 */
export function shouldAutoConnectToolyard(input: {
  readonly signedIn: boolean;
  readonly profile: PersonalMcpProfile | null | undefined;
  readonly attempted: boolean;
}): boolean {
  if (!input.signedIn || input.attempted) return false;
  const toolyard = toolyardIntegrationOf(input.profile);
  return toolyard !== null && !toolyard.credentialConfigured;
}

/**
 * Plain-language reading of a `personalMcp.connectToolyard` error code. toolyard
 * may add codes; anything unknown reads as "could not connect" with the code
 * for the person who goes asking.
 */
export function toolyardConnectErrorMessage(code: string | undefined): string {
  switch (code) {
    case "not_org_member":
      return "Your account isn't in the Beknown org.";
    case "user_disabled":
      return "Your toolyard account is disabled.";
    case "agent_disabled":
      return "Your T3 Code agent is disabled in toolyard.";
    case "invalid_token":
      return "Your sign-in could not be verified. Sign out and back in, then reconnect.";
    case "connect_disabled":
      return "toolyard is not accepting T3 Code connections right now.";
    case "rate_limited":
      return "Too many connection attempts. Try again in a minute.";
    case "clerk_unavailable":
      return "toolyard could not reach the sign-in service. Try again shortly.";
    case "unreachable":
    case "timeout":
      return "toolyard did not answer. Try again shortly.";
    case "store_failed":
      return "T3 could not save the toolyard connection. Try again.";
    case "no_clerk_token":
      return "No sign-in token is available. Sign out and back in, then reconnect.";
    case undefined:
      return "toolyard could not be connected.";
    default:
      return `toolyard could not be connected (${code}).`;
  }
}
