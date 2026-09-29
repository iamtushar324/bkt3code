/**
 * T3-CUSTOM(expbkt3): `t3_user_presence` answers for the caller's own session
 * by default, honours the same session scoping as the other control tools,
 * and passes the person filters through.
 */
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import type { PresenceQuery } from "../../../presence/UserPresenceService.ts";
import { PresenceError, UserPresenceService } from "../../../presence/UserPresenceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const ownThreadId = ThreadId.make("thread-own");
const otherThreadId = ThreadId.make("thread-other");

const invocation = (
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope => ({
  principal: "provider-session",
  actorUserId: UserId.make("user-agent-owner"),
  environmentId: EnvironmentId.make("environment-presence-test"),
  threadId: ownThreadId,
  providerSessionId: "provider-session-presence-test",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(["t3.read"]),
  issuedAt: 1,
  ...overrides,
});

function makeService() {
  const queries: Array<PresenceQuery> = [];
  const service = {
    trackingSince: Effect.succeed(null),
    trackedClients: Effect.succeed([]),
    report: (query: PresenceQuery) => {
      queries.push(query);
      return query.threadId === otherThreadId
        ? Effect.fail(new PresenceError({ reason: "not-found", message: "gone" }))
        : Effect.succeed({ session: { sessionId: String(query.threadId) }, attended: true });
    },
  } as unknown as UserPresenceService["Service"];
  return { service, queries };
}

const provide =
  (service: UserPresenceService["Service"], scope: McpInvocationContext.McpInvocationScope) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(UserPresenceService, service),
      Effect.provideService(OrchestrationAccessControl, {
        canAccessThread: () => Effect.succeed(true),
      } as unknown as OrchestrationAccessControl["Service"]),
    );

it.effect("reports the caller's own session by default and forwards the filters", () =>
  Effect.gen(function* () {
    const { service, queries } = makeService();
    const result = yield* __testing
      .userPresence({ email: "Owner@Example.com", userId: "u1" })
      .pipe(provide(service, invocation()));
    expect(result).toEqual({ session: { sessionId: String(ownThreadId) }, attended: true });
    expect(queries).toEqual([{ threadId: ownThreadId, userId: "u1", email: "Owner@Example.com" }]);
  }),
);

it.effect("refuses another session for an in-session credential", () =>
  Effect.gen(function* () {
    const { service, queries } = makeService();
    const error = yield* Effect.flip(
      __testing.userPresence({ sessionId: otherThreadId }).pipe(provide(service, invocation())),
    );
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toBe("An in-session agent may only control its own T3 session.");
    expect(queries).toEqual([]);
  }),
);

it.effect("requires t3.read", () =>
  Effect.gen(function* () {
    const { service, queries } = makeService();
    const error = yield* Effect.flip(
      __testing
        .userPresence({})
        .pipe(provide(service, invocation({ capabilities: new Set(["preview"]) }))),
    );
    expect(error.message).toBe("This MCP credential does not grant t3.read.");
    expect(queries).toEqual([]);
  }),
);

it.effect("defaults a user-bound provider credential to its own session too", () =>
  Effect.gen(function* () {
    const { service, queries } = makeService();
    const userBound = invocation({ capabilities: new Set(["t3.read", "t3.session.create"]) });
    const result = yield* __testing.userPresence({}).pipe(provide(service, userBound));
    expect(result).toEqual({ session: { sessionId: String(ownThreadId) }, attended: true });
    expect(queries).toEqual([{ threadId: ownThreadId }]);

    const external = invocation({
      principal: "external-user",
      threadId: ThreadId.make("external-user:user-agent-owner"),
      capabilities: new Set(["t3.read", "t3.session.create"]),
    });
    const error = yield* Effect.flip(__testing.userPresence({}).pipe(provide(service, external)));
    expect(error.message).toBe("sessionId is required for a user-wide MCP call.");
  }),
);

it.effect("lets a user-wide credential name a session and surfaces service failures", () =>
  Effect.gen(function* () {
    const { service, queries } = makeService();
    const userWide = invocation({ capabilities: new Set(["t3.read", "t3.session.create"]) });
    const error = yield* Effect.flip(
      __testing.userPresence({ sessionId: otherThreadId }).pipe(provide(service, userWide)),
    );
    expect(error.operation).toBe("user-presence");
    expect(error.message).toBe("gone");
    expect(queries).toEqual([{ threadId: otherThreadId }]);
  }),
);
