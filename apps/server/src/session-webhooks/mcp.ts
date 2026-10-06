/** T3-CUSTOM(expbkt3): agents manage fixed session destinations without seeing signing secrets. */
import { ThreadId, UserId, OrchestratorMcpFailure, SessionWebhookView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/ai";
import { McpInvocationContext, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { hasUserWideScope } from "../mcp/mcpSessionTarget.ts";
import { SessionWebhookService } from "./SessionWebhookService.ts";
import { managedToolyardActor } from "../toolyard/ToolyardIntegration.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [SessionWebhookService, McpInvocationContext],
};
const id = Schema.String.check(Schema.isPattern(/^swh_[a-f0-9]{32}$/));
const revision = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const lifecycleTool = <const Name extends string>(name: Name, description: string) =>
  Tool.make(name, {
    ...shared,
    description,
    parameters: Schema.Struct({ id, expectedRevision: revision }),
    success: SessionWebhookView,
  });
export const SessionWebhookToolkit = Toolkit.make(
  Tool.make("t3_session_webhook_create", {
    ...shared,
    description:
      "Create or obtain an owner-bound Toolyard decision webhook. Provider agents default to this session; external user agents must supply sessionId. An alternative must be accessible to the authenticated initiating user. Pass the opaque callbackRef as callback_ref to Toolyard inbox.request; secrets stay on the servers. This does not create or resume a session. Decisions queue after the active turn and require authoritative Inbox status retrieval before execution.",
    parameters: Schema.Struct({ sessionId: Schema.optional(ThreadId) }),
    success: SessionWebhookView,
  }),
  Tool.make("t3_session_webhook_inspect", {
    ...shared,
    description:
      "Inspect your session webhook destination and durable delivery history. This does not consume grants or dispatch another turn.",
    parameters: Schema.Struct({ id }),
    success: SessionWebhookView,
  }),
  lifecycleTool(
    "t3_session_webhook_disable",
    "Disable your webhook and stop pending callback dispatch. Pass the current revision. This never resumes a paused session.",
  ),
  lifecycleTool(
    "t3_session_webhook_rotate",
    "Rotate your webhook signing secret through the server trust relationship. No secret appears in the result. Pass the current revision.",
  ),
  lifecycleTool(
    "t3_session_webhook_remove",
    "Remove your webhook and stop pending callback dispatch. Pass the current revision. This never resumes a paused session.",
  ),
);
const actor = (capability: "t3.read" | "t3.control") =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext;
    const userId =
      scope.principal === "provider-session"
        ? managedToolyardActor(scope.actorUserId)
        : scope.actorUserId;
    if (userId === null || !scope.capabilities.has(capability))
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `An authenticated user with ${capability} and session access is required.`,
      });
    return { ...scope, actorUserId: UserId.make(userId) };
  });
/** The only session a caller without user-wide scope may touch; `undefined` means any it can see. */
const confinedThreadId = (scope: McpInvocationScope) =>
  hasUserWideScope(scope)
    ? Effect.succeed(undefined)
    : scope.thread === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "This MCP credential is not bound to a T3 session.",
          }),
        )
      : Effect.succeed(scope.thread.threadId);
const failure = (error: unknown) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      typeof error === "object" &&
      error !== null &&
      "detail" in error &&
      typeof error.detail === "string"
        ? error.detail
        : "The webhook operation failed. Inspect the connection and retry.",
  });
export const SessionWebhookHandlersLive = SessionWebhookToolkit.toLayer({
  t3_session_webhook_create: Effect.fn(function* (input) {
    const scope = yield* actor("t3.control");
    if (scope.principal === "external-user" && input.sessionId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "sessionId is required for an external user webhook destination.",
      });
    if (
      input.sessionId !== undefined &&
      input.sessionId !== scope.thread?.threadId &&
      !hasUserWideScope(scope)
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "An in-session agent may only control its own T3 session.",
      });
    const threadId = input.sessionId ?? scope.thread?.threadId;
    if (threadId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "sessionId is required for a caller without its own T3 session.",
      });
    const service = yield* SessionWebhookService;
    return yield* service.create(scope.actorUserId, threadId).pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_inspect: Effect.fn(function* (input) {
    const scope = yield* actor("t3.read");
    return yield* (yield* SessionWebhookService)
      .inspect(scope.actorUserId, input.id, yield* confinedThreadId(scope))
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_disable: Effect.fn(function* (input) {
    const scope = yield* actor("t3.control");
    return yield* (yield* SessionWebhookService)
      .update(
        scope.actorUserId,
        input.id,
        "disable",
        input.expectedRevision,
        yield* confinedThreadId(scope),
      )
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_rotate: Effect.fn(function* (input) {
    const scope = yield* actor("t3.control");
    return yield* (yield* SessionWebhookService)
      .update(
        scope.actorUserId,
        input.id,
        "rotate",
        input.expectedRevision,
        yield* confinedThreadId(scope),
      )
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_remove: Effect.fn(function* (input) {
    const scope = yield* actor("t3.control");
    return yield* (yield* SessionWebhookService)
      .update(
        scope.actorUserId,
        input.id,
        "remove",
        input.expectedRevision,
        yield* confinedThreadId(scope),
      )
      .pipe(Effect.mapError(failure));
  }),
});
export const SessionWebhookToolkitRegistrationLive = McpServer.toolkit(SessionWebhookToolkit).pipe(
  Layer.provide(SessionWebhookHandlersLive),
);
