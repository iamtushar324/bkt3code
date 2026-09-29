/**
 * T3-CUSTOM(expbkt3): which session a presence question is about.
 *
 * Same policy as `resolveMcpSessionTarget`, with one difference an agent
 * relies on: a provider-session credential asking with no `sessionId` means
 * its own session, even when that credential is user-bound and may therefore
 * also name other sessions. The credential was minted for that thread, so no
 * access check is needed for it.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { McpSessionTargetError, resolveMcpSessionTarget } from "../mcp/mcpSessionTarget.ts";

export { McpSessionTargetError };

export const resolvePresenceTarget = Effect.fn("presence.resolveTarget")(function* (
  requested: ThreadId | undefined,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (
    requested === undefined &&
    scope.principal === "provider-session" &&
    scope.capabilities.has("t3.read")
  ) {
    return scope.threadId;
  }
  return yield* resolveMcpSessionTarget({ requested, capability: "t3.read" });
});
