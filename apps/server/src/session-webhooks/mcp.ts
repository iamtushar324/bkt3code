/** T3-CUSTOM(expbkt3): agents manage fixed session destinations without seeing signing secrets. */
import { ThreadId, UserId, OrchestratorMcpFailure, SessionWebhookView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { SessionWebhookService } from "./SessionWebhookService.ts";
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
const toolkit = Toolkit.make(
  Tool.make("t3_session_webhook_create", {
    ...shared,
    description:
      "Create or obtain an owner-bound Toolyard decision webhook. Defaults to this session. An alternative must be accessible to the authenticated initiating user. Pass the opaque callbackRef as callback_ref to Toolyard inbox.request; secrets stay on the servers. This does not create or resume a session. Decisions queue after the active turn and require authoritative Inbox status retrieval before execution.",
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
const actor = Effect.gen(function* () {
  const scope = yield* McpInvocationContext;
  if (scope.actorUserId === null || !scope.capabilities.has("orchestration"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "An authenticated user with session access is required.",
    });
  return { ...scope, actorUserId: UserId.make(scope.actorUserId) };
});
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
const handlers = toolkit.toLayer({
  t3_session_webhook_create: Effect.fn(function* (input) {
    const scope = yield* actor;
    const service = yield* SessionWebhookService;
    return yield* service
      .create(scope.actorUserId, input.sessionId ?? scope.threadId)
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_inspect: Effect.fn(function* (input) {
    const scope = yield* actor;
    return yield* (yield* SessionWebhookService)
      .inspect(scope.actorUserId, input.id)
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_disable: Effect.fn(function* (input) {
    const scope = yield* actor;
    return yield* (yield* SessionWebhookService)
      .update(scope.actorUserId, input.id, "disable", input.expectedRevision)
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_rotate: Effect.fn(function* (input) {
    const scope = yield* actor;
    return yield* (yield* SessionWebhookService)
      .update(scope.actorUserId, input.id, "rotate", input.expectedRevision)
      .pipe(Effect.mapError(failure));
  }),
  t3_session_webhook_remove: Effect.fn(function* (input) {
    const scope = yield* actor;
    return yield* (yield* SessionWebhookService)
      .update(scope.actorUserId, input.id, "remove", input.expectedRevision)
      .pipe(Effect.mapError(failure));
  }),
});
export const SessionWebhookToolkitRegistrationLive = McpServer.toolkit(toolkit).pipe(
  Layer.provide(handlers),
);
