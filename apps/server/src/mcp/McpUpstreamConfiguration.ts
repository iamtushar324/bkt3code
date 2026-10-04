/** T3-CUSTOM(expbkt3): Read-only provider configuration and stable comparison, without credentials. */
import {
  BIFROST_MCP_INTEGRATION_ID,
  PersonalMcpIntegrationId,
  type PersonalMcpProfile,
  type ProviderInstanceId,
  type UserId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import type { McpUpstreamServerConfig } from "./McpProviderSession.ts";

export function configuredUpstreamServers(input: {
  endpoint: string;
  actorUserId: UserId | null;
  providerInstanceId: ProviderInstanceId;
  profile: PersonalMcpProfile | undefined;
}): ReadonlyArray<McpUpstreamServerConfig> {
  const servers =
    input.profile?.integrations
      .filter(
        (integration) =>
          integration.enabled &&
          integration.credentialConfigured &&
          (integration.providerInstanceIds.length === 0 ||
            integration.providerInstanceIds.includes(input.providerInstanceId)),
      )
      .map((integration) => ({
        id: PersonalMcpIntegrationId.make(integration.id),
        name: integration.name,
        endpoint: `${input.endpoint.slice(0, -"/mcp".length)}/mcp/upstream/${encodeURIComponent(integration.id)}`,
        authMode: integration.authMode,
        allowedTools: integration.allowedTools,
        // The proxy URL is stable when its upstream changes. Compare the source without exposing it.
        configurationKey: NodeCrypto.createHash("sha256")
          .update(JSON.stringify([integration.url, integration.configurationKey ?? null]))
          .digest("hex"),
      })) ?? [];
  return input.actorUserId !== null &&
    !servers.some((server) => server.id === BIFROST_MCP_INTEGRATION_ID)
    ? [
        ...servers,
        {
          id: PersonalMcpIntegrationId.make(BIFROST_MCP_INTEGRATION_ID),
          name: "Bifrost",
          endpoint: `${input.endpoint.slice(0, -"/mcp".length)}/mcp/upstream/${BIFROST_MCP_INTEGRATION_ID}`,
          authMode: "x-bf-vk" as const,
          allowedTools: [],
        },
      ]
    : servers;
}

export function upstreamConfigurationKey(servers: ReadonlyArray<McpUpstreamServerConfig>): string {
  return JSON.stringify(
    servers
      .map((server) => ({
        id: server.id,
        name: server.name,
        endpoint: server.endpoint,
        authMode: server.authMode,
        source: server.configurationKey ?? null,
        allowedTools: [...server.allowedTools].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}
