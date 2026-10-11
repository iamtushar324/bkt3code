/**
 * T3-CUSTOM(expbkt3): which session an MCP call acts on.
 *
 * Two kinds of caller reach the same tools. An in-session agent's credential is
 * minted for one thread, so a call that names no session, or names that
 * thread, acts on it, even when the credential is user-wide. An external
 * operator or a user-wide token without a thread must name a session, which
 * is then checked against what its actor can see.
 *
 * This lives outside any one toolkit because it is an authorization decision,
 * not a toolkit's business rule: the control tools and the pull-request tools
 * have to agree on it, and a second copy is how they would stop agreeing.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestrationAccessControl } from "../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

/** Why a session could not be the target, so a caller can say what to do next. */
export const McpSessionTargetErrorCode = Schema.Literals([
  "capability_denied",
  "session_required",
  "session_not_found",
  "session_not_visible",
  "own_session_only",
  "not_session_bound",
]);
export type McpSessionTargetErrorCode = typeof McpSessionTargetErrorCode.Type;

export class McpSessionTargetError extends Schema.TaggedError<McpSessionTargetError>()(
  "McpSessionTargetError",
  { message: Schema.String, code: Schema.optional(McpSessionTargetErrorCode) },
) {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const hasUserWideScope = (scope: McpInvocationContext.McpInvocationScope): boolean =>
  McpInvocationContext.isExternalMcpOperator(scope) ||
  scope.principal === "external-user" ||
  // Background grants provide user-wide reads without granting session creation or control.
  scope.backgroundGrantHash !== undefined ||
  scope.capabilities.has("t3.session.create");

/**
 * The refusal for a session the actor cannot see. It says whether the session
 * exists here, because agents most often pass an id from another T3 server, a
 * message id, or a provider transcript id, and need to know which mistake it was.
 */
const sessionNotVisible = Effect.fn("mcp.sessionNotVisible")(function* (threadId: ThreadId) {
  const snapshots = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const exists = Option.isSome(snapshots)
    ? yield* snapshots.value.getThreadAccessById(threadId).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => undefined),
      )
    : undefined;
  if (exists === true) {
    return new McpSessionTargetError({
      code: "session_not_visible",
      message: `T3 session ${threadId} exists, but your user cannot see it. Ask its owner to tag you on it.`,
    });
  }
  return new McpSessionTargetError({
    code: "session_not_found",
    message:
      exists === false
        ? `T3 session ${threadId} was not found on this T3 server. Use a session id from this server: an id from another T3 server, a message id or a provider transcript id does not work. Find the session with t3_list_sessions.`
        : `T3 session ${threadId} was not found.`,
  });
});

export const resolveMcpSessionTarget = Effect.fn("mcp.resolveSessionTarget")(function* (options: {
  readonly requested: ThreadId | undefined;
  readonly capability: McpInvocationContext.McpCapability;
}) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has(options.capability)) {
    return yield* new McpSessionTargetError({
      code: "capability_denied",
      message: `This MCP credential does not grant ${options.capability}.`,
    });
  }
  // The credential was minted for this thread, so its own session needs no
  // access check, and an agent rarely knows its own session id.
  const own = scope.thread?.threadId;
  if (own !== undefined && (options.requested === undefined || options.requested === own)) {
    return own;
  }
  if (hasUserWideScope(scope)) {
    if (options.requested === undefined) {
      return yield* new McpSessionTargetError({
        code: "session_required",
        message:
          "sessionId is required for a user-wide MCP call: this MCP client has no T3 session of its own. Find the session with t3_list_sessions and pass its sessionId.",
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
        const refusal = yield* sessionNotVisible(options.requested);
        return yield* refusal;
      }
    }
    return options.requested;
  }
  // A client caller without user-wide scope has no own session to fall back to.
  if (scope.thread === undefined) {
    return yield* new McpSessionTargetError({
      code: "not_session_bound",
      message: "This MCP credential is not bound to a T3 session.",
    });
  }
  return yield* new McpSessionTargetError({
    code: "own_session_only",
    message:
      "An in-session agent may only control its own T3 session. Omit sessionId to act on your own session.",
  });
});
