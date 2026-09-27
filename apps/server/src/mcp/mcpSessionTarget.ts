/**
 * T3-CUSTOM(expbkt3): which session an MCP call acts on.
 *
 * Two kinds of caller reach the same tools. An in-session agent's credential is
 * minted for one thread and may only ever touch that one, so it never names a
 * session. An external operator or a user-wide token has no thread of its own
 * and must name one, which is then checked against what its actor can see.
 *
 * This lives outside any one toolkit because it is an authorization decision,
 * not a toolkit's business rule: the control tools and the pull-request tools
 * have to agree on it, and a second copy is how they would stop agreeing.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { OrchestrationAccessControl } from "../orchestration/Services/AccessControl.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export class McpSessionTargetError extends Schema.TaggedError<McpSessionTargetError>()(
  "McpSessionTargetError",
  { message: Schema.String },
) {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const hasUserWideScope = (scope: McpInvocationContext.McpInvocationScope): boolean =>
  McpInvocationContext.isExternalMcpOperator(scope) ||
  scope.principal === "external-user" ||
  scope.capabilities.has("t3.session.create");

export const resolveMcpSessionTarget = Effect.fn("mcp.resolveSessionTarget")(function* (options: {
  readonly requested: ThreadId | undefined;
  readonly capability: McpInvocationContext.McpCapability;
}) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has(options.capability)) {
    return yield* new McpSessionTargetError({
      message: `This MCP credential does not grant ${options.capability}.`,
    });
  }
  if (hasUserWideScope(scope)) {
    if (options.requested === undefined) {
      return yield* new McpSessionTargetError({
        message: "sessionId is required for a user-wide MCP call.",
      });
    }
    // An external operator is trusted machinery; a user-bound token is only
    // ever allowed the sessions its own actor can already see.
    if (!McpInvocationContext.isExternalMcpOperator(scope) && scope.actorUserId !== null) {
      const accessControl = yield* OrchestrationAccessControl;
      const allowed = yield* accessControl
        .canAccessThread(scope.actorUserId, options.requested)
        .pipe(
          Effect.mapError((cause) => new McpSessionTargetError({ message: errorMessage(cause) })),
        );
      if (!allowed) {
        return yield* new McpSessionTargetError({
          message: `T3 session ${options.requested} was not found.`,
        });
      }
    }
    return options.requested;
  }
  if (options.requested !== undefined && options.requested !== scope.threadId) {
    return yield* new McpSessionTargetError({
      message: "An in-session agent may only control its own T3 session.",
    });
  }
  return scope.threadId;
});
