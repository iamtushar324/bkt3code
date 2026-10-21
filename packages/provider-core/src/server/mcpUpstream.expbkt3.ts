// T3-CUSTOM(expbkt3): personal MCP integrations. Users can register upstream MCP
// servers (e.g. Bifrost, Toolyard) that get proxied into the provider session
// alongside T3's own tools. Re-exported from `mcpSession.ts`.
import {
  BIFROST_MCP_INTEGRATION_ID,
  TOOLYARD_MCP_INTEGRATION_ID,
  type PersonalMcpAuthMode,
  type PersonalMcpIntegrationId,
} from "@t3tools/contracts";

export interface McpUpstreamServerConfig {
  readonly id: PersonalMcpIntegrationId;
  readonly name: string;
  readonly endpoint: string;
  readonly authMode: PersonalMcpAuthMode;
  readonly allowedTools: ReadonlyArray<string>;
  /** Hash of upstream source and readiness behind the stable local proxy. */
  readonly configurationKey?: string;
}

export function upstreamMcpServerName(server: McpUpstreamServerConfig): string {
  if (server.id === BIFROST_MCP_INTEGRATION_ID) return BIFROST_MCP_INTEGRATION_ID;
  // The built-in gateway keeps its plain name so tools read `mcp__toolyard__*`.
  if (server.id === TOOLYARD_MCP_INTEGRATION_ID) return TOOLYARD_MCP_INTEGRATION_ID;
  return `t3_user_${server.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
