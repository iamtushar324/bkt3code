/**
 * T3-CUSTOM(expbkt3): Maps an MCP principal onto the same authenticated-session
 * shape used by the web socket RPC layer.
 */
import {
  AuthAdministrativeScopes,
  AuthSessionId,
  AuthStandardClientScopes,
  clerkSubjectForUser,
  EnvironmentUserId,
} from "@t3tools/contracts";

import type * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";

export const makeWebUiAuthenticatedSession = (
  invocation: McpInvocationContext.McpInvocationScope,
): EnvironmentAuth.AuthenticatedSession => {
  const actorUserId = invocation.actorUserId;
  const isAdministrative =
    invocation.principal === "external-operator" ||
    (invocation.principal === "provider-session" && actorUserId === null);
  return {
    sessionId: AuthSessionId.make(`mcp-web-ui:${invocation.providerSessionId}`),
    userId: actorUserId === null ? null : EnvironmentUserId.make(actorUserId),
    subject:
      actorUserId === null
        ? `mcp-web-ui:${invocation.principal}`
        : clerkSubjectForUser(actorUserId),
    method: "bearer-access-token",
    scopes: isAdministrative ? AuthAdministrativeScopes : AuthStandardClientScopes,
  };
};
