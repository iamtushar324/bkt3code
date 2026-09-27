import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const actorUserId = UserId.make("user-session-controller");
const accessibleThreadId = ThreadId.make("thread-accessible");
const inaccessibleThreadId = ThreadId.make("thread-private");
const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId,
  environmentId: EnvironmentId.make("environment-control-test"),
  threadId: ThreadId.make("thread-current"),
  providerSessionId: "provider-session-control-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["t3.read", "t3.control", "t3.plan", "t3.session.create"]),
  issuedAt: 1,
};
const accessControl = OrchestrationAccessControl.of({
  actorFor: () => Option.some(actorUserId),
  canAccessThread: (_userId, threadId) => Effect.succeed(threadId === accessibleThreadId),
  canAccessProject: () => Effect.succeed(false),
  canTransferThreadOwnership: () => Effect.succeed(false),
  canTransferProjectOwnership: () => Effect.succeed(false),
});
const provideAuthorization = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(OrchestrationAccessControl, accessControl),
  );

it.effect("allows a user-bound session to control another accessible session", () =>
  Effect.gen(function* () {
    const resolved = yield* provideAuthorization(
      __testing.resolveSessionId("control-test", accessibleThreadId, "t3.control"),
    );
    expect(resolved).toBe(accessibleThreadId);
  }),
);

it.effect("hides an inaccessible session from a user-bound session", () =>
  Effect.gen(function* () {
    const error = yield* provideAuthorization(
      __testing.resolveSessionId("control-test", inaccessibleThreadId, "t3.control"),
    ).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toBe(`T3 session ${inaccessibleThreadId} was not found.`);
  }),
);
