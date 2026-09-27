// T3-CUSTOM(expbkt3): session lineage decider coverage.
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeThread(id: string, parentThreadId: string | null) {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    ownerUserId: null,
    memberUserIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    priority: null,
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        ownerUserId: null,
        memberUserIds: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      makeThread("parent", null),
      makeThread("child", "parent"),
      makeThread("unrelated", null),
    ],
    updatedAt: NOW,
  } as unknown as OrchestrationReadModel;
}

const createCommandBase = {
  type: "thread.create" as const,
  projectId: ProjectId.make("project-1"),
  title: "Spawned session",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  sourceControlProfileId: null,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("thread lineage decider", (it) => {
  it.effect("carries a parent through thread.create", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-child"),
          threadId: ThreadId.make("spawned"),
          parentThreadId: ThreadId.make("parent"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentThreadId).toBe("parent");
      }
    }),
  );

  it.effect("defaults an omitted parent to null, so a human-started session is a root", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-root"),
          threadId: ThreadId.make("standalone"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentThreadId).toBe(null);
      }
    }),
  );

  // T3-CUSTOM(expbkt3): BEGIN — a parent may live on another environment.
  it.effect("records the environment a parent lives on at creation", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-remote-child"),
          threadId: ThreadId.make("spawned-here"),
          parentThreadId: ThreadId.make("parent-elsewhere"),
          parentEnvironmentId: EnvironmentId.make("environment-remote"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentThreadId).toBe("parent-elsewhere");
        expect(events[0].payload.parentEnvironmentId).toBe("environment-remote");
      }
    }),
  );

  it.effect("leaves a same-environment parent's environment null", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-local-child"),
          threadId: ThreadId.make("spawned-local"),
          parentThreadId: ThreadId.make("parent"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.parentEnvironmentId).toBe(null);
      }
    }),
  );

  it.effect("files a session under a parent on another environment", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-move-remote"),
          threadId: ThreadId.make("child"),
          parentThreadId: ThreadId.make("coordinator-elsewhere"),
          parentEnvironmentId: EnvironmentId.make("environment-remote"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.parentThreadId).toBe("coordinator-elsewhere");
        expect(events[0].payload.parentEnvironmentId).toBe("environment-remote");
      }
    }),
  );

  it.effect("does not read a foreign parent id as a local cycle", () =>
    Effect.gen(function* () {
      // "parent" is a descendant-forming id *here*; named on another
      // environment it is a different session entirely, and the local walk
      // must not reject it.
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-move-foreign-collision"),
          threadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("child"),
          parentEnvironmentId: EnvironmentId.make("environment-remote"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
    }),
  );
  // T3-CUSTOM(expbkt3): END

  it.effect("re-parents through thread.meta.update", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-move"),
          threadId: ThreadId.make("child"),
          parentThreadId: ThreadId.make("unrelated"),
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.parentThreadId).toBe("unrelated");
      }
    }),
  );

  it.effect("detaches when the command sends null", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-detach"),
          threadId: ThreadId.make("child"),
          parentThreadId: null,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.parentThreadId).toBe(null);
      }
    }),
  );

  it.effect("leaves lineage untouched when the command omits it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-rename-only"),
          threadId: ThreadId.make("child"),
          title: "Renamed",
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        // undefined, not null: an omitted field must not detach the thread.
        expect(events[0].payload.parentThreadId).toBe(undefined);
      }
    }),
  );

  it.effect("rejects parenting a thread under its own descendant", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-cycle"),
            threadId: ThreadId.make("parent"),
            parentThreadId: ThreadId.make("child"),
          },
          readModel: makeReadModel(),
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  it.effect("rejects a thread parenting itself", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-self"),
            threadId: ThreadId.make("child"),
            parentThreadId: ThreadId.make("child"),
          },
          readModel: makeReadModel(),
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
