import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asUserId = (value: string): UserId => UserId.make(value);

const NOW = "2026-02-01T00:00:00.000Z";
const OWNER = asUserId("user_owner");
const ALICE = asUserId("user_alice");
const BOB = asUserId("user_bob");
const PROJECT = asProjectId("project-members");
const THREAD = asThreadId("thread-members");
const WEB_THREAD = asThreadId("thread-created-from-web");

// A read model with one project + thread both owned by OWNER.
const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(NOW);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: PROJECT,
    type: "project.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: PROJECT,
      title: "Members Project",
      workspaceRoot: "/tmp/members-project",
      defaultModelSelection: null,
      scripts: [],
      createdByUserId: OWNER,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: THREAD,
    type: "thread.created",
    occurredAt: NOW,
    commandId: asCommandId("cmd-thread-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: THREAD,
      projectId: PROJECT,
      title: "Members Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdByUserId: OWNER,
      sourceControlProfileId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  });
});

type PlannedEvent = Omit<OrchestrationEvent, "sequence">;

const applyPlanned = (
  readModel: Parameters<typeof projectEvent>[0],
  events: PlannedEvent | ReadonlyArray<PlannedEvent>,
) => {
  const list = Array.isArray(events) ? events : [events];
  let next = readModel;
  let sequence = readModel.snapshotSequence;
  return Effect.gen(function* () {
    for (const event of list) {
      sequence += 1;
      next = yield* projectEvent(next, { ...event, sequence });
    }
    return next;
  });
};

it.layer(NodeServices.layer)("decider membership invariants", (it) => {
  it.effect("makes the authenticated web creator both owner and tagged member", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      // The web bootstrap dispatches `thread.create` ahead of the turn (see
      // turnStartBootstrap.expbkt3.ts); the authenticated actor outranks a
      // nominated owner on that command.
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: asCommandId("cmd-web-thread-create"),
          threadId: WEB_THREAD,
          projectId: PROJECT,
          title: "Web-created thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          sourceControlProfileId: null,
          ownerUserId: BOB,
          createdAt: NOW,
        },
        readModel,
        actor: ALICE,
      });
      const events = Array.isArray(decided) ? decided : [decided];
      const created = events.find((event) => event.type === "thread.created");

      expect(created?.type).toBe("thread.created");
      if (created?.type === "thread.created") {
        expect(created.payload.createdByUserId).toBe(ALICE);
      }

      const projected = yield* applyPlanned(readModel, events);
      const thread = projected.threads.find((entry) => entry.id === WEB_THREAD);
      expect(thread?.ownerUserId).toBe(ALICE);
      expect(thread?.memberUserIds).toEqual([ALICE]);
    }),
  );

  it.effect("adds a thread member and records the actor", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.member.add",
          commandId: asCommandId("cmd-add-alice"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel,
        actor: OWNER,
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event.type).toBe("thread.member-added");
      if (event.type === "thread.member-added") {
        expect(event.payload.userId).toBe(ALICE);
        expect(event.payload.addedByUserId).toBe(OWNER);
      }
    }),
  );

  it.effect("rejects adding the owner as a member", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.member.add",
            commandId: asCommandId("cmd-add-owner"),
            threadId: THREAD,
            userId: OWNER,
          },
          readModel,
          actor: OWNER,
        }),
      );
      expect((error as { detail: string }).detail).toContain("permanent member");
    }),
  );

  it.effect("rejects adding a duplicate member", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const added = yield* decideOrchestrationCommand({
        command: {
          type: "thread.member.add",
          commandId: asCommandId("cmd-add-alice"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel: seeded,
        actor: OWNER,
      });
      const readModel = yield* applyPlanned(seeded, added);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.member.add",
            commandId: asCommandId("cmd-add-alice-again"),
            threadId: THREAD,
            userId: ALICE,
          },
          readModel,
          actor: OWNER,
        }),
      );
      expect((error as { detail: string }).detail).toContain("already a member");
    }),
  );

  it.effect("rejects removing the owner (creator permanence)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.member.remove",
            commandId: asCommandId("cmd-remove-owner"),
            threadId: THREAD,
            userId: OWNER,
          },
          readModel,
          actor: ALICE,
        }),
      );
      expect((error as { detail: string }).detail).toContain("cannot be removed");
    }),
  );

  it.effect("rejects removing a non-member", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.member.remove",
            commandId: asCommandId("cmd-remove-bob"),
            threadId: THREAD,
            userId: BOB,
          },
          readModel,
          actor: OWNER,
        }),
      );
      expect((error as { detail: string }).detail).toContain("not a member");
    }),
  );

  it.effect("removes a tagged member", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const added = yield* decideOrchestrationCommand({
        command: {
          type: "thread.member.add",
          commandId: asCommandId("cmd-add-alice"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel: seeded,
        actor: OWNER,
      });
      const readModel = yield* applyPlanned(seeded, added);
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.member.remove",
          commandId: asCommandId("cmd-remove-alice"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel,
        actor: OWNER,
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event.type).toBe("thread.member-removed");
    }),
  );

  it.effect("adds and removes a project member", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "project.member.add",
          commandId: asCommandId("cmd-add-project-alice"),
          projectId: PROJECT,
          userId: ALICE,
        },
        readModel,
        actor: OWNER,
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event.type).toBe("project.member-added");
      if (event.type === "project.member-added") {
        expect(event.payload.userId).toBe(ALICE);
        expect(event.payload.addedByUserId).toBe(OWNER);
      }
    }),
  );

  it.effect("projector reflects owner from created events and membership from member events", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const thread = seeded.threads.find((entry) => entry.id === THREAD);
      expect(thread?.ownerUserId).toBe(OWNER);
      expect(thread?.memberUserIds).toEqual([OWNER]);

      const added = yield* decideOrchestrationCommand({
        command: {
          type: "thread.member.add",
          commandId: asCommandId("cmd-add-alice"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel: seeded,
        actor: OWNER,
      });
      const afterAdd = yield* applyPlanned(seeded, added);
      expect(afterAdd.threads.find((entry) => entry.id === THREAD)?.memberUserIds).toEqual([
        OWNER,
        ALICE,
      ]);
    }),
  );

  it.effect("transfers thread ownership and retains the previous owner as a member", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const added = yield* decideOrchestrationCommand({
        command: {
          type: "thread.member.add",
          commandId: asCommandId("cmd-add-transfer-target"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel: seeded,
        actor: OWNER,
      });
      const withMember = yield* applyPlanned(seeded, added);
      const transferred = yield* decideOrchestrationCommand({
        command: {
          type: "thread.owner.transfer",
          commandId: asCommandId("cmd-transfer-thread-owner"),
          threadId: THREAD,
          userId: ALICE,
        },
        readModel: withMember,
        actor: OWNER,
      });
      const event = Array.isArray(transferred) ? transferred[0] : transferred;
      expect(event.type).toBe("thread.owner-transferred");
      if (event.type === "thread.owner-transferred") {
        expect(event.payload.previousOwnerUserId).toBe(OWNER);
        expect(event.payload.ownerUserId).toBe(ALICE);
        expect(event.payload.transferredByUserId).toBe(OWNER);
      }

      const projected = yield* applyPlanned(withMember, transferred);
      const thread = projected.threads.find((entry) => entry.id === THREAD);
      expect(thread?.ownerUserId).toBe(ALICE);
      expect(thread?.memberUserIds).toEqual([OWNER]);
    }),
  );

  it.effect("transfers project ownership and retains the previous owner as a member", () =>
    Effect.gen(function* () {
      const seeded = yield* seedReadModel;
      const transferred = yield* decideOrchestrationCommand({
        command: {
          type: "project.owner.transfer",
          commandId: asCommandId("cmd-transfer-project-owner"),
          projectId: PROJECT,
          userId: BOB,
        },
        readModel: seeded,
        actor: OWNER,
      });
      const projected = yield* applyPlanned(seeded, transferred);
      const project = projected.projects.find((entry) => entry.id === PROJECT);
      expect(project?.ownerUserId).toBe(BOB);
      expect(project?.memberUserIds).toEqual([OWNER]);
    }),
  );
});
