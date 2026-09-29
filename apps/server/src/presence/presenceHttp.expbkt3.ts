/**
 * T3-CUSTOM(expbkt3): `GET /api/presence` — the `t3_user_presence` answer for
 * scripts that do not speak MCP.
 *
 *   GET /api/presence?sessionId=<threadId>[&userId=…][&email=…]
 *   Authorization: Bearer <T3_MCP_BEARER_TOKEN>
 *
 * The bearer is the same credential the MCP endpoint takes (provider-session,
 * external-user or external-operator) and the target session is authorized the
 * same way the control tools do it: an in-session credential may only ask
 * about its own session (and may omit `sessionId`), a user-wide credential
 * must name a session its actor can see. The body is `PresenceReport` JSON.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { resolveMcpSessionTarget } from "../mcp/mcpSessionTarget.ts";
import { OrchestrationAccessControl } from "../orchestration/Services/AccessControl.ts";
import { PRESENCE_ROUTE_PATH } from "./presenceEnvironment.expbkt3.ts";
import { UserPresenceService } from "./UserPresenceService.ts";

export { PRESENCE_ROUTE_PATH };

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const jsonError = (status: number, error: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error, message },
    { status, headers: { "cache-control": "no-store" } },
  );

const bearerToken = (request: HttpServerRequest.HttpServerRequest): string => {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") === true
    ? authorization.slice("Bearer ".length).trim()
    : "";
};

/** The handler, with its services injected so tests can run it without a server. */
export const presenceHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const presence = yield* UserPresenceService;

  const invocation = yield* registry.resolve(bearerToken(request));
  if (!invocation) {
    return HttpServerResponse.jsonUnsafe(
      {
        error: "invalid_mcp_credential",
        message: "A valid T3 MCP bearer credential (T3_MCP_BEARER_TOKEN) is required.",
      },
      { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
    );
  }

  const url = HttpServerRequest.toURL(request);
  const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
  const rawSessionId = params.get("sessionId");
  let requested: ThreadId | undefined;
  if (rawSessionId !== null && rawSessionId.length > 0) {
    const decoded = decodeThreadId(rawSessionId);
    if (Option.isNone(decoded)) {
      return jsonError(400, "invalid-request", "sessionId is not a valid T3 session id.");
    }
    requested = decoded.value;
  }

  const target = yield* Effect.result(
    resolveMcpSessionTarget({ requested, capability: "t3.read" }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    ),
  );
  if (Result.isFailure(target)) {
    // A missing sessionId on a user-wide credential is the caller's mistake;
    // an inaccessible session reads as not found, exactly as the tools do.
    const message = target.failure.message;
    return jsonError(message.includes("required") ? 400 : 404, "session-unavailable", message);
  }

  const userId = params.get("userId");
  const email = params.get("email");
  const report = yield* Effect.result(
    presence.report({
      threadId: target.success,
      ...(userId ? { userId } : {}),
      ...(email ? { email } : {}),
    }),
  );
  if (Result.isFailure(report)) {
    return jsonError(
      report.failure.reason === "not-found" ? 404 : 500,
      report.failure.reason,
      report.failure.message,
    );
  }
  return HttpServerResponse.jsonUnsafe(report.success, {
    headers: { "cache-control": "no-store" },
  });
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning("presence route failed", { error }).pipe(
      Effect.as(jsonError(500, "internal-error", "The presence report could not be built.")),
    ),
  ),
);

/** Services are captured once, when the route layer is built. */
export const presenceRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const accessControl = yield* OrchestrationAccessControl;
    const presence = yield* UserPresenceService;
    return HttpRouter.add(
      "GET",
      PRESENCE_ROUTE_PATH,
      presenceHandler.pipe(
        Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
        Effect.provideService(OrchestrationAccessControl, accessControl),
        Effect.provideService(UserPresenceService, presence),
      ),
    );
  }),
);
