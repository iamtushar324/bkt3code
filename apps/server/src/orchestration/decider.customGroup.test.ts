// T3-CUSTOM(expbkt3): custom sidebar group decider and contract coverage.
import {
  CommandId,
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadMetaUpdatedPayload,
  THREAD_CUSTOM_GROUP_MAX_LENGTH,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);
const decodeMetaUpdatedPayload = Schema.decodeUnknownSync(ThreadMetaUpdatedPayload);

function makeReadModel(customGroup: string | null = null): OrchestrationReadModel {
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
      {
        pullRequests: [],
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
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
        customGroup,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const metaUpdated = (result: unknown) => {
  const events = Array.isArray(result) ? result : [result];
  const first = events[0] as { type?: string; payload?: { customGroup?: string | null } };
  expect(first.type).toBe("thread.meta-updated");
  return first.payload ?? {};
};

it.layer(NodeServices.layer)("thread custom group decider", (it) => {
  it.effect("carries a custom group through thread.create", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-grouped"),
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "Grouped thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          sourceControlProfileId: null,
          createdAt: NOW,
          customGroup: "Sprint 42",
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.customGroup).toBe("Sprint 42");
      }
    }),
  );

  it.effect("defaults an omitted custom group to null on create", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-plain"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-1"),
          title: "Plain thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          sourceControlProfileId: null,
          createdAt: NOW,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(result) ? result : [result];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.customGroup).toBe(null);
      }
    }),
  );

  it.effect("sets a custom group through thread.meta.update", () =>
    Effect.gen(function* () {
      const payload = metaUpdated(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-set-group"),
            threadId: ThreadId.make("thread-1"),
            customGroup: "Sprint 42",
          },
          readModel: makeReadModel(),
        }),
      );
      expect(payload.customGroup).toBe("Sprint 42");
    }),
  );

  it.effect("clears the custom group when the command sends null", () =>
    Effect.gen(function* () {
      const payload = metaUpdated(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-clear-group"),
            threadId: ThreadId.make("thread-1"),
            customGroup: null,
          },
          readModel: makeReadModel("Sprint 42"),
        }),
      );
      expect(payload.customGroup).toBe(null);
    }),
  );

  it.effect("leaves the custom group untouched when the command omits it", () =>
    Effect.gen(function* () {
      const payload = metaUpdated(
        yield* decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-rename-only"),
            threadId: ThreadId.make("thread-1"),
            title: "Renamed",
          },
          readModel: makeReadModel("Sprint 42"),
        }),
      );
      // undefined, not null: an omitted field must not clear stored state.
      expect(payload.customGroup).toBe(undefined);
    }),
  );
});

// The decider trusts its typed input; the wire contract is where a label is
// trimmed and bounded. These pin that contract so a client or MCP caller
// cannot store a blank or oversized group.
it("trims a custom group on the thread.meta.update command", () => {
  const command = decodeCommand({
    type: "thread.meta.update",
    commandId: "cmd-trim",
    threadId: "thread-1",
    customGroup: "  Sprint 42  ",
  });
  expect(command.type === "thread.meta.update" ? command.customGroup : undefined).toBe("Sprint 42");
});

it("rejects a blank or oversized custom group on the wire", () => {
  const decode = (customGroup: string) =>
    decodeCommand({
      type: "thread.meta.update",
      commandId: "cmd-invalid",
      threadId: "thread-1",
      customGroup,
    });
  expect(() => decode("   ")).toThrow();
  expect(() => decode("x".repeat(THREAD_CUSTOM_GROUP_MAX_LENGTH + 1))).toThrow();
  expect(() => decode("x".repeat(THREAD_CUSTOM_GROUP_MAX_LENGTH))).not.toThrow();
});

// Title ownership moved to upstream's `titleState`; the fork fields it used to
// ride on were removed from the contracts. Events and commands written while
// they existed still carry the keys and must keep decoding.
it("ignores the retired title-ownership keys on stored events and commands", () => {
  const payload = decodeMetaUpdatedPayload({
    threadId: "thread-1",
    title: "Named by hand",
    titleManuallySet: true,
    updatedAt: NOW,
  });
  expect(payload.title).toBe("Named by hand");
  expect("titleManuallySet" in payload).toBe(false);

  const command = decodeCommand({
    type: "thread.meta.update",
    commandId: "cmd-legacy",
    threadId: "thread-1",
    title: "Named by hand",
    titleOrigin: "user",
  });
  expect(command.type === "thread.meta.update" ? command.title : undefined).toBe("Named by hand");
});
