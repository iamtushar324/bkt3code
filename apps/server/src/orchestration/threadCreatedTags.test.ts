// T3-CUSTOM(expbkt3): inherited session tags at creation time.
//
// A session created from another session is born tagged with that session's
// audience, so delegated work never disappears from the sidebar of the person
// who asked for it. This covers both halves of that: the decider carrying the
// tag list onto thread.created, and the projector folding it into the thread's
// members alongside the creator.
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const owner = UserId.make("user-owner");
const tagged = UserId.make("user-tagged");
const other = UserId.make("user-other");

const readModel = {
  snapshotSequence: 0,
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project-1",
      defaultModelSelection: null,
      scripts: [],
      ownerUserId: owner,
      memberUserIds: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("parent"),
      projectId: ProjectId.make("project-1"),
      title: "Parent session",
      ownerUserId: owner,
      memberUserIds: [owner, tagged],
      parentThreadId: null,
      messages: [],
      activities: [],
      checkpoints: [],
      archivedAt: null,
      deletedAt: null,
    },
  ],
  updatedAt: NOW,
} as unknown as OrchestrationReadModel;

const createCommandBase = {
  type: "thread.create" as const,
  projectId: ProjectId.make("project-1"),
  title: "Delegated session",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  sourceControlProfileId: null,
  createdAt: NOW,
};

function makeThreadCreatedEvent(payload: Record<string, unknown>): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.make("event-1"),
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: NOW,
    commandId: CommandId.make("cmd-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: "thread-1",
      projectId: "project-1",
      title: "Delegated session",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      sourceControlProfileId: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...payload,
    },
  } as unknown as OrchestrationEvent;
}

const memberUserIdsAfter = (payload: Record<string, unknown>) =>
  projectEvent(createEmptyReadModel(NOW), makeThreadCreatedEvent(payload)).pipe(
    Effect.map((model) => model.threads[0]?.memberUserIds ?? []),
  );

it.layer(NodeServices.layer)("inherited session tags", (it) => {
  it.effect("carries the tag list onto thread.created", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-tagged"),
          threadId: ThreadId.make("spawned"),
          ownerUserId: owner,
          memberUserIds: [tagged, other],
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.memberUserIds).toEqual([tagged, other]);
      }
    }),
  );

  it.effect("defaults a root session to no extra tags, so it stays private", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-plain"),
          threadId: ThreadId.make("standalone"),
          ownerUserId: owner,
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.memberUserIds).toEqual([]);
      }
    }),
  );

  it.effect("inherits the parent session's audience when none is stated", () =>
    Effect.gen(function* () {
      // The side-by-side session a person starts from a sidebar row lands here:
      // the client names a parent and says nothing about tags.
      const decided = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-child"),
          threadId: ThreadId.make("child"),
          ownerUserId: other,
          parentThreadId: ThreadId.make("parent"),
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.memberUserIds).toEqual([owner, tagged]);
      }
    }),
  );

  it.effect("leaves the creator out of the inherited audience", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-child-by-owner"),
          threadId: ThreadId.make("child-owned"),
          ownerUserId: owner,
          parentThreadId: ThreadId.make("parent"),
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.memberUserIds).toEqual([tagged]);
      }
    }),
  );

  it.effect("honours an explicit empty audience over the parent's", () =>
    Effect.gen(function* () {
      // This is how a caller says "keep this to myself" for a nested session.
      const decided = yield* decideOrchestrationCommand({
        command: {
          ...createCommandBase,
          commandId: CommandId.make("cmd-create-child-private"),
          threadId: ThreadId.make("child-private"),
          ownerUserId: other,
          parentThreadId: ThreadId.make("parent"),
          memberUserIds: [],
        },
        readModel,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.memberUserIds).toEqual([]);
      }
    }),
  );

  it.effect("projects inherited tags alongside the creator", () =>
    Effect.gen(function* () {
      const members = yield* memberUserIdsAfter({
        createdByUserId: owner,
        memberUserIds: [tagged, other],
      });
      expect(members).toEqual([owner, tagged, other]);
    }),
  );

  it.effect("never tags the creator twice", () =>
    Effect.gen(function* () {
      const members = yield* memberUserIdsAfter({
        createdByUserId: owner,
        memberUserIds: [owner, tagged],
      });
      expect(members).toEqual([owner, tagged]);
    }),
  );

  it.effect("still tags inherited members when the creator is unknown", () =>
    Effect.gen(function* () {
      // Single-user mode has no creator, but a trusted external creator can
      // still nominate an audience.
      const members = yield* memberUserIdsAfter({
        createdByUserId: null,
        memberUserIds: [tagged],
      });
      expect(members).toEqual([tagged]);
    }),
  );

  it.effect("decodes a pre-tagging thread.created event", () =>
    Effect.gen(function* () {
      const members = yield* memberUserIdsAfter({ createdByUserId: owner });
      expect(members).toEqual([owner]);
    }),
  );
});
