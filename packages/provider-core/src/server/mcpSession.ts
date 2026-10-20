import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): control-plane actor identity and personal MCP integrations.
import type { UserId } from "@t3tools/contracts";
import type { McpUpstreamServerConfig } from "./mcpUpstream.expbkt3.ts";
// T3-CUSTOM(expbkt3): personal MCP integrations, re-exported for adapters.
export { type McpUpstreamServerConfig, upstreamMcpServerName } from "./mcpUpstream.expbkt3.ts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  // T3-CUSTOM(expbkt3): control-plane actor identity.
  readonly actorUserId: UserId | null;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  // T3-CUSTOM(expbkt3): personal MCP integrations to proxy.
  readonly upstreamServers: ReadonlyArray<McpUpstreamServerConfig>;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
