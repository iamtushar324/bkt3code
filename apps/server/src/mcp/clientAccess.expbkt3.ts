/**
 * T3-CUSTOM(expbkt3): every caller from outside T3 is one of upstream's MCP
 * clients (`McpInvocationScope.client`), whichever way it signed in.
 *
 * Upstream's OAuth sign-in is the main route. The fork's Settings-issued
 * bearer credentials (Bifrost, Toolyard `BkT3`, which send a fixed
 * Authorization header and cannot do OAuth) resolve to the same client model:
 * an access level that `McpToolAccess` declarations check, plus the fork's
 * additive fields (`principal`, `actorUserId`, `t3.*` capabilities) that the
 * team boundary and the control tools read.
 */
import type { AuthMcpClientAccess, UserId } from "@t3tools/contracts";

import type { McpCapability, McpInvocationScope } from "./McpInvocationContext.ts";

/** The upstream capabilities an OAuth client holds (see `McpOAuth.layerMcpClientAuthenticator`). */
export const UPSTREAM_CLIENT_CAPABILITIES = [
  "orchestration",
  "worktree",
  "pull-requests",
] as const satisfies ReadonlyArray<McpCapability>;

/** Fork capabilities that only read. Anything else lets a credential change something. */
const READ_ONLY_FORK_CAPABILITIES: ReadonlySet<McpCapability> = new Set(["t3.read"]);

/**
 * The access level a Settings-issued credential carries: read-only when every
 * fork capability it was issued with only reads, otherwise full access, the
 * ceiling those credentials always had.
 */
export const clientAccessFromCapabilities = (
  capabilities: Iterable<McpCapability>,
): AuthMcpClientAccess =>
  Array.from(capabilities).every((capability) => READ_ONLY_FORK_CAPABILITIES.has(capability))
    ? "read-only"
    : "full-access";

/**
 * The scope of a Settings-issued credential: its fork capabilities plus the
 * upstream client set, with an access level derived from the former.
 */
export const settingsCredentialClientScope = (input: {
  readonly principal: "external-user" | "external-operator";
  readonly actorUserId: UserId | null;
  readonly sessionId: string;
  readonly label: string;
  readonly forkCapabilities: ReadonlyArray<McpCapability>;
}): Pick<McpInvocationScope, "principal" | "actorUserId" | "client" | "capabilities"> => ({
  principal: input.principal,
  actorUserId: input.actorUserId,
  client: {
    sessionId: input.sessionId,
    label: input.label,
    access: clientAccessFromCapabilities(input.forkCapabilities),
  },
  capabilities: new Set<McpCapability>([
    ...UPSTREAM_CLIENT_CAPABILITIES,
    ...input.forkCapabilities,
  ]),
});

/**
 * The fork fields of an OAuth client. A client approved from a browser
 * session (or a pairing code) that names a team user acts as that user, so
 * the team boundary in `forkAccess.expbkt3.ts` limits it to that user's
 * threads. An unbound client has no team boundary, as upstream; it is an
 * operator (operator-only tools, administrative web UI scopes) only when the
 * approving grant or session held `access:write`
 * (`auth/mcpApprovalPolicy.expbkt3.ts`).
 */
export const oauthClientForkFields = (input: {
  readonly access: AuthMcpClientAccess;
  readonly userId: UserId | null;
  readonly operator: boolean;
}): Pick<McpInvocationScope, "principal" | "actorUserId"> & {
  readonly forkCapabilities: ReadonlyArray<McpCapability>;
} => ({
  principal: input.userId === null && input.operator ? "external-operator" : "external-user",
  actorUserId: input.userId,
  forkCapabilities:
    input.access === "read-only"
      ? ["t3.read"]
      : ["t3.read", "t3.control", "t3.plan", "t3.session.create"],
});
