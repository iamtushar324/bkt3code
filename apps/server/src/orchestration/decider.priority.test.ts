// T3-CUSTOM(expbkt3): session priority decider coverage.
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ThreadPriority,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function makeReadModel(priority: ThreadPriority | null = null): OrchestrationReadModel {
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
        // T3-CUSTOM(expbkt3): upstream's linked pull requests; empty on a fresh fixture.
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
        priority,
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

it.layer(NodeServices.layer)("thread priority decider", (it) => {
  it.effect("carries a priority through thread.create", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create-p0"),
          threadId: ThreadId.make("thread-2"),
          projectId: ProjectId.make("project-1"),
          title: "Urgent thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          sourceControlProfileId: null,
          createdAt: NOW,
          priority: 0,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.priority).toBe(0);
      }
    }),
  );

  it.effect("defaults an omitted priority to null on create", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
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
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.priority).toBe(null);
      }
    }),
  );

  it.effect("sets a priority through thread.meta.update", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-set-p1"),
          threadId: ThreadId.make("thread-1"),
          priority: 1,
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("thread.meta-updated");
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.priority).toBe(1);
      }
    }),
  );

  it.effect("clears a priority when the command sends null", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear"),
          threadId: ThreadId.make("thread-1"),
          priority: null,
        },
        readModel: makeReadModel(2),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        expect(events[0].payload.priority).toBe(null);
      }
    }),
  );

  it.effect("leaves priority untouched when the command omits it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-rename-only"),
          threadId: ThreadId.make("thread-1"),
          title: "Renamed",
        },
        readModel: makeReadModel(3),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        // undefined, not null: an omitted field must not clear stored state.
        expect(events[0].payload.priority).toBe(undefined);
      }
    }),
  );

  it.effect("sets and clears a manual Linear issue through thread metadata", () =>
    Effect.gen(function* () {
      const tagged = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-tag-linear"),
          threadId: ThreadId.make("thread-1"),
          linearIssueUrl: "https://linear.app/beknown/issue/TEC-811",
        },
        readModel: makeReadModel(),
      });
      const taggedEvents = Array.isArray(tagged) ? tagged : [tagged];
      expect(
        taggedEvents[0]?.type === "thread.meta-updated"
          ? taggedEvents[0].payload.linearIssueUrl
          : undefined,
      ).toBe("https://linear.app/beknown/issue/TEC-811");

      const cleared = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear-linear"),
          threadId: ThreadId.make("thread-1"),
          linearIssueUrl: null,
        },
        readModel: makeReadModel(),
      });
      const clearedEvents = Array.isArray(cleared) ? cleared : [cleared];
      expect(
        clearedEvents[0]?.type === "thread.meta-updated"
          ? clearedEvents[0].payload.linearIssueUrl
          : undefined,
      ).toBeNull();
    }),
  );

  // T3-CUSTOM(expbkt3): the Mattermost conversation a session is bound to.
  it.effect("sets and clears a Mattermost link through thread metadata", () =>
    Effect.gen(function* () {
      const linked = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-link-mattermost"),
          threadId: ThreadId.make("thread-1"),
          mattermostThreadUrl: "https://chat.example.com/beknown/pl/abc123",
        },
        readModel: makeReadModel(),
      });
      const linkedEvents = Array.isArray(linked) ? linked : [linked];
      expect(
        linkedEvents[0]?.type === "thread.meta-updated"
          ? linkedEvents[0].payload.mattermostThreadUrl
          : undefined,
      ).toBe("https://chat.example.com/beknown/pl/abc123");

      const cleared = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-clear-mattermost"),
          threadId: ThreadId.make("thread-1"),
          mattermostThreadUrl: null,
        },
        readModel: makeReadModel(),
      });
      const clearedEvents = Array.isArray(cleared) ? cleared : [cleared];
      expect(
        clearedEvents[0]?.type === "thread.meta-updated"
          ? clearedEvents[0].payload.mattermostThreadUrl
          : undefined,
      ).toBeNull();
    }),
  );

  it.effect("leaves the Mattermost link untouched when the command omits it", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-rename-only-mattermost"),
          threadId: ThreadId.make("thread-1"),
          title: "Renamed",
        },
        readModel: makeReadModel(),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "thread.meta-updated") {
        // undefined, not null: an omitted field must not clear a live binding.
        expect(events[0].payload.mattermostThreadUrl).toBe(undefined);
      }
    }),
  );
});
