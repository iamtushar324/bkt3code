/** T3-CUSTOM(expbkt3): A local proxy remains discoverable through temporary remote outages. */
import type { PersonalMcpIntegration } from "@t3tools/contracts";
import type { ToolyardConnectionCore } from "./ToolyardConnectionCore.ts";

export function toolyardManagedProfile(
  status: Awaited<ReturnType<ToolyardConnectionCore["status"]>>,
): PersonalMcpIntegration | null {
  if (status.removed || status.baseUrl === null) return null;
  return {
    id: "toolyard",
    name: "toolyard",
    url: `${status.baseUrl}/mcp`,
    enabled: status.enabled,
    authMode: "bearer",
    customHeaderName: "",
    // The server owns remote credentials and obtains them lazily through the local proxy.
    credentialConfigured:
      status.enabled && (status.connection === "connected" || status.connection === "unavailable"),
    providerInstanceIds: [],
    allowedTools: [],
    // A provider that cached failed discovery must refresh once the remote connection recovers.
    configurationKey: `${status.instanceId}:${status.connection}`,
    ...(status.email ? { connectedEmail: status.email } : {}),
  };
}
