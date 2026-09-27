// T3-CUSTOM(expbkt3): custom sidebar group on the MCP control tools.
//
// Covers the three seams an agent touches: the label is validated the same
// way a client's is before it reaches the projection, `t3_update_session`
// forwards it (null clears), and `t3_list_sessions` reports and filters on it
// case-insensitively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  THREAD_CUSTOM_GROUP_MAX_LENGTH,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationAccessControl } from "../../../orchestration/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration/turnStartBootstrap.expbkt3.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const actorUserId = UserId.make("user-grouper");
const sessionId = ThreadId.make("thread-grouped");
const projectId = ProjectId.make("project-groups");

const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId,
  environmentId: EnvironmentId.make("environment-groups"),
  threadId: sessionId,
  providerSessionId: "provider-session-groups",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["t3.read", "t3.control"]),
  issuedAt: 1,
};

const accessControl = OrchestrationAccessControl.of({
  actorFor: () => Option.some(actorUserId),
  canAccessThread: () => Effect.succeed(true),
  canAccessProject: () => Effect.succeed(true),
  canTransferThreadOwnership: () => Effect.succeed(false),
  canTransferProjectOwnership: () => Effect.succeed(false),
});

function makeThread(id: string, customGroup: string | null) {
  return {
    id: ThreadId.make(id),
    projectId,
    title: `Session ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    ownerUserId: actorUserId,
    memberUserIds: [],
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:03.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    titleRegeneration: null,
    priority: null,
    customGroup,
    linearIssueUrl: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const query = {
  getSnapshot: () => Effect.die("full projection snapshot materialized"),
  getShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 1,
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          repositoryIdentity: null,
          defaultModelSelection: null,
          threadCreationDefaults: { baseRef: null, setupScript: null },
          scripts: [],
          ownerUserId: null,
          memberUserIds: [],
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        },
      ],
      threads: [
        makeThread("thread-sprint", "Sprint 42"),
        makeThread("thread-loose", null),
        makeThread("thread-other", "Bugs"),
      ],
      updatedAt: "2026-08-05T00:00:03.000Z",
    }),
  getArchivedShellSnapshot: () => Effect.die("archived shell should not be read"),
} as unknown as ProjectionSnapshotQuery["Service"];

const provideReads = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(ProjectionSnapshotQuery, query),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(OrchestrationAccessControl, accessControl),
  );

it.effect("validates a custom group label like a client would", () =>
  Effect.gen(function* () {
    expect(yield* __testing.resolveCustomGroupInput("t", undefined)).toBe(undefined);
    expect(yield* __testing.resolveCustomGroupInput("t", null)).toBe(null);
    expect(yield* __testing.resolveCustomGroupInput("t", "  Sprint   42 ")).toBe("Sprint 42");

    const blank = yield* __testing.resolveCustomGroupInput("t", "   ").pipe(Effect.flip);
    expect(blank).toBeInstanceOf(T3ControlToolError);
    expect(blank.message).toContain("must not be blank");

    const long = yield* __testing
      .resolveCustomGroupInput("t", "x".repeat(THREAD_CUSTOM_GROUP_MAX_LENGTH + 1))
      .pipe(Effect.flip);
    expect(long.message).toContain(`at most ${THREAD_CUSTOM_GROUP_MAX_LENGTH}`);
  }),
);

it("matches the list filter exactly but case-insensitively", () => {
  expect(__testing.matchesCustomGroupFilter({ customGroup: "Sprint 42" }, "sprint 42")).toBe(true);
  expect(__testing.matchesCustomGroupFilter({ customGroup: "Sprint 42" }, "Sprint")).toBe(false);
  expect(__testing.matchesCustomGroupFilter({ customGroup: null }, "sprint 42")).toBe(false);
  expect(__testing.matchesCustomGroupFilter({ customGroup: null }, undefined)).toBe(true);
});

it.effect("reports each session's custom group and filters the list by it", () =>
  Effect.gen(function* () {
    const all = yield* provideReads(__testing.listSessions({}));
    expect(all.sessions.map((session) => [session.sessionId, session.customGroup])).toEqual([
      ["thread-sprint", "Sprint 42"],
      ["thread-loose", null],
      ["thread-other", "Bugs"],
    ]);

    const filtered = yield* provideReads(__testing.listSessions({ customGroup: "sprint 42" }));
    expect(filtered.sessions.map((session) => session.sessionId)).toEqual(["thread-sprint"]);
  }),
);

it.layer(NodeServices.layer)("t3_update_session custom group", (it) => {
  const dispatched: OrchestrationCommand[] = [];
  const dispatcher = TurnStartBootstrap.of({
    dispatch: (command) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
    createThread: () => Effect.die("createThread should not be called"),
  });
  const update = (input: Parameters<typeof __testing.updateSession>[0]) =>
    __testing
      .updateSession(input)
      .pipe(Effect.provideService(TurnStartBootstrap, dispatcher), provideReads);

  it.effect("forwards a trimmed label and null to thread.meta.update", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      yield* update({ sessionId, customGroup: "  Sprint 42 " });
      yield* update({ sessionId, customGroup: null });
      const metaUpdates = dispatched.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.meta.update" }> =>
          command.type === "thread.meta.update",
      );
      expect(metaUpdates.map((command) => command.customGroup)).toEqual(["Sprint 42", null]);
      expect(metaUpdates.every((command) => command.threadId === sessionId)).toBe(true);
    }),
  );

  it.effect("leaves the group alone when the call does not mention it", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      yield* update({ sessionId, title: "Renamed" });
      const command = dispatched[0];
      expect(command?.type).toBe("thread.meta.update");
      expect(command && "customGroup" in command).toBe(false);
    }),
  );

  it.effect("rejects a blank label before anything is dispatched", () =>
    Effect.gen(function* () {
      dispatched.length = 0;
      const error = yield* update({ sessionId, customGroup: " " }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(T3ControlToolError);
      expect(dispatched).toHaveLength(0);
    }),
  );
});
