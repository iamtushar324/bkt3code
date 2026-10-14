/**
 * T3-CUSTOM(expbkt3): counts every T3 MCP tool call by name (TEC-1631).
 *
 * `McpToolAccess.toLayer` is the one place every `/mcp` toolkit's handlers are
 * built, keyed by tool name, so wrapping them there covers every tool. Only
 * the name, caller kind, outcome and duration are recorded, never arguments.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { type McpToolCaller, withMcpToolAnalytics } from "../telemetry/serverEvents.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const currentCaller: Effect.Effect<McpToolCaller | undefined> = Effect.serviceOption(
  McpInvocationContext.McpInvocationContext,
).pipe(
  Effect.map((scope) =>
    Option.isNone(scope)
      ? undefined
      : { principal: scope.value.principal, actorUserId: scope.value.actorUserId },
  ),
);

/** `handlers` with each Effect-returning handler timed and recorded under its key. */
export function withMcpToolCallAnalytics<Handlers>(handlers: Handlers): Handlers {
  const wrapped: Record<string, unknown> = {};
  for (const [toolName, handler] of Object.entries(handlers as Record<string, unknown>)) {
    wrapped[toolName] =
      typeof handler === "function"
        ? (...args: ReadonlyArray<unknown>) => {
            const result = (handler as (...params: ReadonlyArray<unknown>) => unknown)(...args);
            return Effect.isEffect(result)
              ? // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- handlers are heterogeneous; types pass through unchanged.
                withMcpToolAnalytics(toolName, currentCaller, result)
              : result;
          }
        : handler;
  }
  return wrapped as Handlers;
}
