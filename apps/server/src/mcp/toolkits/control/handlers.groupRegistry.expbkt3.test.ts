// T3-CUSTOM(expbkt3): the shared custom-group registry on the MCP control
// tools (XFN-59).
//
// Covers what an agent does with groups beyond filing one session:
// `t3_group_save` makes an empty group or recolours one in server settings,
// `t3_group_list` reports saved groups next to label-only ones, and
// `t3_group_rename` / `t3_group_remove` change the registry and re-file every
// session the caller can see.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  THREAD_CUSTOM_GROUP_COLOR_IDS,
  type OrchestrationCommand,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationAccessControl } from "../../../orchestration-v2/Services/AccessControl.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import { TurnStartBootstrap } from "../../../orchestration-v2/turnStartBootstrap.expbkt3.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { T3ControlToolError } from "./tools.ts";
import { __testing } from "./handlers.ts";

const actorUserId = UserId.make("user-grouper");
const strangerUserId = UserId.make("user-stranger");
const sessionId = ThreadId.make("thread-sprint-a");
const projectId = ProjectId.make("project-groups");

const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId,
  environmentId: EnvironmentId.make("environment-groups"),
  requestNamespace: "provider-session-groups",
  thread: {
    threadId: sessionId,
    providerSessionId: "provider-session-groups",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
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

function makeThread(id: string, customGroup: string | null, ownerUserId: UserId = actorUserId) {
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
    ownerUserId,
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

const threads = [
  makeThread("thread-sprint-a", "Sprint 42"),
  makeThread("thread-sprint-b", "sprint 42"),
  makeThread("thread-bugs", "Bugs"),
  makeThread("thread-loose", null),
  // Someone else's session in the same group: the caller cannot see it, so it
  // is neither counted nor re-filed.
  makeThread("thread-hidden", "Sprint 42", strangerUserId),
];

const query = {
  getSnapshot: () => Effect.die("full projection snapshot materialized"),
  getShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 1,
      projects: [],
      threads,
      updatedAt: "2026-08-05T00:00:03.000Z",
    }),
  getArchivedShellSnapshot: () => Effect.die("archived shell should not be read"),
} as unknown as ProjectionSnapshotQuery["Service"];

/** In-memory settings that apply patches through the real merge rule. */
function makeSettings(initial: ServerSettings["threadCustomGroups"] = {}) {
  let current: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, threadCustomGroups: initial };
  const patches: ServerSettingsPatch[] = [];
  const service = {
    getSettings: Effect.sync(() => current),
    updateSettings: (patch: ServerSettingsPatch) =>
      Effect.sync(() => {
        patches.push(patch);
        current = applyServerSettingsPatch(current, patch);
        return current;
      }),
  } as unknown as ServerSettingsService["Service"];
  return { service, patches, read: () => current.threadCustomGroups };
}

type MetaUpdate = Extract<OrchestrationCommand, { type: "thread.meta.update" }>;

function makeDispatcher(refuse: ReadonlySet<string> = new Set()) {
  const dispatched: MetaUpdate[] = [];
  const service = TurnStartBootstrap.of({
    dispatch: (command) => {
      if (command.type !== "thread.meta.update") {
        return Effect.die(`unexpected ${command.type}`);
      }
      if (refuse.has(command.threadId)) {
        return Effect.fail(
          new OrchestrationDispatchCommandError({ message: "runs above your modes" }),
        );
      }
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
    createThread: () => Effect.die("createThread should not be called"),
  });
  return { service, dispatched };
}

const provide =
  (
    settings: ServerSettingsService["Service"],
    dispatcher: TurnStartBootstrap["Service"] = makeDispatcher().service,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ProjectionSnapshotQuery, query),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(OrchestrationAccessControl, accessControl),
      Effect.provideService(ServerSettingsService, settings),
      Effect.provideService(TurnStartBootstrap, dispatcher),
    );

it.effect("validates a colour id and lists the allowed ones when it is unknown", () =>
  Effect.gen(function* () {
    expect(yield* __testing.resolveGroupColorInput("t", undefined)).toBe(undefined);
    expect(yield* __testing.resolveGroupColorInput("t", null)).toBe(null);
    expect(yield* __testing.resolveGroupColorInput("t", " Teal ")).toBe("teal");
    const error = yield* __testing.resolveGroupColorInput("t", "chartreuse").pipe(Effect.flip);
    expect(error).toBeInstanceOf(T3ControlToolError);
    expect(error.message).toContain("chartreuse");
    expect(error.message).toContain(THREAD_CUSTOM_GROUP_COLOR_IDS.join(", "));
  }),
);

it.layer(NodeServices.layer)("t3_group_save", (it) => {
  it.effect("saves an empty group, then recolours it without losing the label", () =>
    Effect.gen(function* () {
      const settings = makeSettings();
      const created = yield* __testing
        .groupSave({ label: "  Release   train ", color: "violet" })
        .pipe(provide(settings.service));
      expect(created).toEqual({
        saved: true,
        created: true,
        group: { label: "Release train", colorId: "violet" },
      });
      expect(settings.read()).toEqual({
        "release train": { label: "Release train", colorId: "violet" },
      });

      // An omitted colour keeps the saved one; another spelling replaces the label.
      const respelled = yield* __testing
        .groupSave({ label: "release Train" })
        .pipe(provide(settings.service));
      expect(respelled.created).toBe(false);
      expect(settings.read()).toEqual({
        "release train": { label: "release Train", colorId: "violet" },
      });

      yield* __testing
        .groupSave({ label: "Release train", color: "emerald" })
        .pipe(provide(settings.service));
      expect(settings.read()["release train"]?.colorId).toBe("emerald");

      yield* __testing
        .groupSave({ label: "Release train", color: null })
        .pipe(provide(settings.service));
      expect(settings.read()).toEqual({ "release train": { label: "Release train" } });
    }),
  );

  it.effect("rejects an unknown colour and a blank label before writing", () =>
    Effect.gen(function* () {
      const settings = makeSettings();
      const badColour = yield* __testing
        .groupSave({ label: "Backlog", color: "plaid" })
        .pipe(provide(settings.service), Effect.flip);
      expect(badColour.message).toContain("is not a custom group colour");
      const blank = yield* __testing
        .groupSave({ label: "   " })
        .pipe(provide(settings.service), Effect.flip);
      expect(blank.message).toContain("label must not be blank");
      // The sidebar's built-in section owns this name in any spelling.
      const reserved = yield* __testing
        .groupSave({ label: " UNGROUPED " })
        .pipe(provide(settings.service), Effect.flip);
      expect(reserved.message).toContain("built-in section for sessions with no group");
      expect(settings.patches).toHaveLength(0);
    }),
  );
});

it.effect("lists saved groups and label-only groups the caller can see", () =>
  Effect.gen(function* () {
    const settings = makeSettings({
      "sprint 42": { label: "Sprint 42", colorId: "blue" },
      "empty one": { label: "Empty one", colorId: "slate" },
    });
    const listed = yield* __testing.groupList({}).pipe(provide(settings.service));
    expect(listed.colors).toEqual([...THREAD_CUSTOM_GROUP_COLOR_IDS]);
    expect(listed.groups).toEqual([
      { label: "Bugs", colorId: null, registered: false, sessionCount: 1 },
      { label: "Empty one", colorId: "slate", registered: true, sessionCount: 0 },
      // Two visible sessions, case-insensitively; the stranger's is not counted.
      { label: "Sprint 42", colorId: "blue", registered: true, sessionCount: 2 },
    ]);

    const one = yield* __testing.groupList({ label: "SPRINT 42" }).pipe(provide(settings.service));
    expect(one.groups.map((group) => group.label)).toEqual(["Sprint 42"]);
  }),
);

it.layer(NodeServices.layer)("t3_group_rename", (it) => {
  it.effect("renames the saved group, keeps its colour and re-files visible sessions", () =>
    Effect.gen(function* () {
      const settings = makeSettings({ "sprint 42": { label: "Sprint 42", colorId: "blue" } });
      const dispatcher = makeDispatcher();
      const result = yield* __testing
        .groupRename({ label: "sprint 42", newLabel: "Sprint 43" })
        .pipe(provide(settings.service, dispatcher.service));
      expect(settings.read()).toEqual({ "sprint 43": { label: "Sprint 43", colorId: "blue" } });
      expect(
        dispatcher.dispatched.map((command) => [command.threadId, command.customGroup]),
      ).toEqual([
        ["thread-sprint-a", "Sprint 43"],
        ["thread-sprint-b", "Sprint 43"],
      ]);
      expect(result).toMatchObject({
        renamed: true,
        previousLabel: "Sprint 42",
        group: { label: "Sprint 43", colorId: "blue", registered: true },
        sessionsMoved: 2,
        skipped: [],
      });
    }),
  );

  it.effect("renames a label-only group on its sessions without saving it", () =>
    Effect.gen(function* () {
      const settings = makeSettings();
      const dispatcher = makeDispatcher();
      const result = yield* __testing
        .groupRename({ label: "bugs", newLabel: "Defects" })
        .pipe(provide(settings.service, dispatcher.service));
      expect(settings.patches).toHaveLength(0);
      expect(dispatcher.dispatched.map((command) => command.threadId)).toEqual(["thread-bugs"]);
      expect(result.group).toEqual({ label: "Defects", colorId: null, registered: false });
    }),
  );

  it.effect("reports a session the orchestrator refuses instead of failing the rest", () =>
    Effect.gen(function* () {
      const settings = makeSettings({ "sprint 42": { label: "Sprint 42" } });
      const dispatcher = makeDispatcher(new Set(["thread-sprint-b"]));
      const result = yield* __testing
        .groupRename({ label: "Sprint 42", newLabel: "Sprint 43" })
        .pipe(provide(settings.service, dispatcher.service));
      expect(result.movedSessionIds).toEqual(["thread-sprint-a"]);
      expect(result.skipped).toEqual([
        { sessionId: "thread-sprint-b", reason: "runs above your modes" },
      ]);
    }),
  );

  it.effect("refuses a missing group and a name that is already another group", () =>
    Effect.gen(function* () {
      const settings = makeSettings({ "sprint 42": { label: "Sprint 42" } });
      const dispatcher = makeDispatcher();
      const missing = yield* __testing
        .groupRename({ label: "Nope", newLabel: "Still nope" })
        .pipe(provide(settings.service, dispatcher.service), Effect.flip);
      expect(missing.message).toContain("no custom group named 'Nope'");
      const taken = yield* __testing
        .groupRename({ label: "Sprint 42", newLabel: "BUGS" })
        .pipe(provide(settings.service, dispatcher.service), Effect.flip);
      expect(taken.message).toContain("already exists");
      expect(settings.patches).toHaveLength(0);
      expect(dispatcher.dispatched).toHaveLength(0);
    }),
  );
});

it.layer(NodeServices.layer)("t3_group_remove", (it) => {
  it.effect("deletes the saved group and ungroups the visible sessions", () =>
    Effect.gen(function* () {
      const settings = makeSettings({
        "sprint 42": { label: "Sprint 42", colorId: "red" },
        bugs: { label: "Bugs" },
      });
      const dispatcher = makeDispatcher();
      const result = yield* __testing
        .groupRemove({ label: "SPRINT 42" })
        .pipe(provide(settings.service, dispatcher.service));
      expect(settings.patches).toEqual([{ threadCustomGroups: { "sprint 42": null } }]);
      expect(settings.read()).toEqual({ bugs: { label: "Bugs" } });
      expect(
        dispatcher.dispatched.map((command) => [command.threadId, command.customGroup]),
      ).toEqual([
        ["thread-sprint-a", null],
        ["thread-sprint-b", null],
      ]);
      expect(result).toMatchObject({
        removed: true,
        label: "Sprint 42",
        savedGroupRemoved: true,
        sessionsUngrouped: 2,
        skipped: [],
      });
    }),
  );

  it.effect("is a safe no-op for a group that does not exist", () =>
    Effect.gen(function* () {
      const settings = makeSettings();
      const dispatcher = makeDispatcher();
      const result = yield* __testing
        .groupRemove({ label: "Ghost" })
        .pipe(provide(settings.service, dispatcher.service));
      expect(result).toMatchObject({
        removed: false,
        savedGroupRemoved: false,
        sessionsUngrouped: 0,
      });
      expect(settings.patches).toHaveLength(0);
      expect(dispatcher.dispatched).toHaveLength(0);
    }),
  );

  it.effect("accepts the reserved Ungrouped name as the group to clear", () =>
    Effect.gen(function* () {
      const settings = makeSettings();
      const dispatcher = makeDispatcher();
      // A stray "Ungrouped" label can reach sessions through other tools; the
      // agent must be able to clear it, so only new names are refused.
      const result = yield* __testing
        .groupRemove({ label: "Ungrouped" })
        .pipe(provide(settings.service, dispatcher.service));
      expect(result).toMatchObject({ removed: false, savedGroupRemoved: false });
      expect(settings.patches).toHaveLength(0);
    }),
  );
});
