/** T3-CUSTOM(expbkt3): Load the server-owned profile after authenticated client connection.
 * Browser JWTs no longer provision or renew Toolyard credentials. The server
 * also establishes access on provider discovery and calls without this component.
 */
import { usePersonalMcpProfile } from "../hooks/usePersonalMcpProfile";
export function resetToolyardAutoConnectForTests(): void {}
export function ToolyardAutoConnect(): null {
  usePersonalMcpProfile();
  return null;
}
