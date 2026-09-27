// T3-CUSTOM(expbkt3): session lineage on t3_create_session.
//
// Covers the full createAsChild matrix: nesting is the agent's call, and the
// implicit default must never fire for a synthetic external-user scope.
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const actorUserId = UserId.make("user-lineage");
const callerThreadId = ThreadId.make("thread-caller");
const openProjectId = ProjectId.make("project-open");
const closedProjectId = ProjectId.make("project-closed");
const openParentId = ThreadId.make("thread-open-parent");
const closedParentId = ThreadId.make("thread-closed-parent");

const threads = [
  { id: callerThreadId, projectId: openProjectId },
  { id: openParentId, projectId: openProjectId },
  { id: closedParentId, projectId: closedProjectId },
];

function makeScope(
  overrides: Partial<McpInvocationContext.McpInvocationScope> = {},
): McpInvocationContext.McpInvocationScope {
  return {
    principal: "provider-session",
    actorUserId,
    environmentId: EnvironmentId.make("environment-lineage"),
    threadId: callerThreadId,
    providerSessionId: "provider-session-lineage",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["t3.read", "t3.control", "t3.session.create"]),
    issuedAt: 1,
    ...overrides,
  };
}

const accessControl = OrchestrationAccessControl.of({
  actorFor: () => Option.some(actorUserId),
  canAccessThread: () => Effect.succeed(true),
  canAccessProject: (_userId, projectId) => Effect.succeed(projectId === openProjectId),
  canTransferThreadOwnership: () => Effect.succeed(false),
  canTransferProjectOwnership: () => Effect.succeed(false),
});

const resolve = (input: {
  readonly scope?: McpInvocationContext.McpInvocationScope;
  readonly createAsChild?: boolean;
  readonly parentSessionId?: string;
}) =>
  __testing
    .resolveCreatedSessionParent({
      operation: "create-session",
      scope: input.scope ?? makeScope(),
      threads,
      createAsChild: input.createAsChild,
      parentSessionId: input.parentSessionId,
    })
    .pipe(Effect.provideService(OrchestrationAccessControl, accessControl));

it.effect("nests under the calling session by default", () =>
  Effect.gen(function* () {
    expect(yield* resolve({})).toBe(callerThreadId);
  }),
);

it.effect("nests when createAsChild is explicitly true", () =>
  Effect.gen(function* () {
    expect(yield* resolve({ createAsChild: true })).toBe(callerThreadId);
  }),
);

it.effect("creates a top-level session when createAsChild is false", () =>
  Effect.gen(function* () {
    expect(yield* resolve({ createAsChild: false })).toBe(null);
  }),
);

it.effect("never parents an external-user token to its synthetic scope", () =>
  Effect.gen(function* () {
    // scope.threadId is not a session the user is working in, so defaulting to
    // it would build one giant bogus tree.
    const scope = makeScope({ principal: "external-user" });
    expect(yield* resolve({ scope })).toBe(null);
  }),
);

it.effect("never parents an external operator implicitly", () =>
  Effect.gen(function* () {
    const scope = makeScope({ principal: "external-operator" });
    expect(yield* resolve({ scope })).toBe(null);
  }),
);

it.effect("honours an explicit accessible parent", () =>
  Effect.gen(function* () {
    expect(yield* resolve({ parentSessionId: openParentId })).toBe(openParentId);
  }),
);

it.effect("hides a parent whose project the caller cannot access", () =>
  Effect.gen(function* () {
    const error = yield* resolve({ parentSessionId: closedParentId }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toBe(`T3 session ${closedParentId} was not found.`);
  }),
);

it.effect("reports an unknown parent as absent", () =>
  Effect.gen(function* () {
    const error = yield* resolve({ parentSessionId: "thread-does-not-exist" }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
  }),
);

it.effect("refuses a contradictory createAsChild:false plus parentSessionId", () =>
  Effect.gen(function* () {
    const error = yield* resolve({
      createAsChild: false,
      parentSessionId: openParentId,
    }).pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toContain("cannot be combined with parentSessionId");
  }),
);

it.effect("lets an external operator name a parent without an access check", () =>
  Effect.gen(function* () {
    const scope = makeScope({ principal: "external-operator" });
    expect(yield* resolve({ scope, parentSessionId: closedParentId })).toBe(closedParentId);
  }),
);
