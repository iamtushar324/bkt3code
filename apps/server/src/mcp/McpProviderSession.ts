// T3-CUSTOM(expbkt3): BEGIN — personal MCP integrations: users can register upstream MCP
// servers (e.g. Bifrost) that get proxied into the provider session alongside T3's own tools.
import {
  BIFROST_MCP_INTEGRATION_ID,
  type EnvironmentId,
  type PersonalMcpAuthMode,
  type PersonalMcpIntegrationId,
  type ProviderInstanceId,
  type ThreadId,
  type UserId,
} from "@t3tools/contracts";

import { withPresenceEnvironment } from "../presence/presenceEnvironment.expbkt3.ts"; // T3-CUSTOM(expbkt3): BK_T3_PRESENCE_URL.

export interface McpUpstreamServerConfig {
  readonly id: PersonalMcpIntegrationId;
  readonly name: string;
  readonly endpoint: string;
  readonly authMode: PersonalMcpAuthMode;
  readonly allowedTools: ReadonlyArray<string>;
}

export function upstreamMcpServerName(server: McpUpstreamServerConfig): string {
  if (server.id === BIFROST_MCP_INTEGRATION_ID) return BIFROST_MCP_INTEGRATION_ID;
  return `t3_user_${server.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
// T3-CUSTOM(expbkt3): END

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly actorUserId: UserId | null; // T3-CUSTOM(expbkt3): control-plane actor identity.
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly upstreamServers: ReadonlyArray<McpUpstreamServerConfig>; // T3-CUSTOM(expbkt3): personal MCP integrations to proxy.
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  // T3-CUSTOM(expbkt3): every adapter passes the full config; endpoint and
  // threadId feed BK_T3_PRESENCE_URL (presence/presenceEnvironment.expbkt3.ts).
  config:
    | (Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> &
        Partial<Pick<McpProviderSessionConfig, "endpoint" | "threadId">>)
    | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  // T3-CUSTOM(expbkt3): BEGIN — presence URL rides on the same seam as the device env.
  const withPresence = withPresenceEnvironment(base, config);
  if (!extra) return withPresence;
  // T3-CUSTOM(expbkt3): END
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...withPresence, // T3-CUSTOM(expbkt3): was `...base`.
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
