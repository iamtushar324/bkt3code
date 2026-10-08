/**
 * T3-CUSTOM(expbkt3): who may approve an outside MCP agent's OAuth sign-in, and
 * what the agent becomes.
 *
 * Upstream lets any pairing code that holds the agent's scopes, or any browser
 * session holding `access:write`, approve a client. The fork adds two rules:
 *
 * - With `environmentUserIdentityMode: "required"`, the approval must name a
 *   team user: a browser session bound to one, or a pairing code minted for one
 *   (`clerk:<userId>` subject). This is the same rule `/oauth/token` applies to
 *   pairing exchanges (`isEnvironmentIdentityRequired`).
 * - An approval that names no user makes an operator (no team boundary,
 *   operator-only tools, administrative web UI scopes) only when the approving
 *   grant or session itself holds `access:write`. Anything less makes an
 *   unbound, non-operator client.
 */
import {
  AuthAccessWriteScope,
  type AuthEnvironmentScope,
  type EnvironmentUserIdentityMode,
} from "@t3tools/contracts";

/** The environment rule that refuses an approval or exchange naming no team user. */
export const isEnvironmentIdentityRequired = (mode: EnvironmentUserIdentityMode): boolean =>
  mode === "required";

/** Whether an approval from a grant or session with these scopes makes an operator. */
export const approvalGrantsOperator = (scopes: ReadonlyArray<AuthEnvironmentScope>): boolean =>
  scopes.includes(AuthAccessWriteScope);
