// T3-CUSTOM(expbkt3): BEGIN — T3 MCP control plane (external session/project control via MCP).
/**
 * T3-CUSTOM(expbkt3): Per-invocation capability and session-scope enforcement
 * for the experimental T3 MCP control plane.
 */
// T3-CUSTOM(expbkt3): END
import {
  type EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
  type UserId, // T3-CUSTOM(expbkt3): control-plane actor identity.
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

// T3-CUSTOM(expbkt3): union grows with the control-plane capabilities below.
export type McpCapability =
  | "preview"
  | "device"
  | "pull-requests"
  // T3-CUSTOM(expbkt3): capabilities for the fork's T3 MCP control plane.
  | "t3.read"
  | "t3.control"
  | "t3.plan"
  | "t3.session.create"
  | "t3.project.create"
  | "t3.settings.manage";

export interface McpInvocationScope {
  readonly principal: "provider-session" | "external-user" | "external-operator";
  /** User whose authority and personal integrations back this invocation. */
  readonly actorUserId: UserId | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

// T3-CUSTOM(expbkt3): BEGIN — MCP control-plane operator/session-creation gating.
export function isExternalMcpOperator(scope: McpInvocationScope): boolean {
  return scope.principal === "external-operator";
}

export function canCreateMcpSessions(scope: McpInvocationScope): boolean {
  return scope.capabilities.has("t3.session.create") || isExternalMcpOperator(scope);
}
// T3-CUSTOM(expbkt3): END

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation) => invocation.capabilities.has(capability),
      // The conditional type narrows what the literal argument decided at runtime.
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );
