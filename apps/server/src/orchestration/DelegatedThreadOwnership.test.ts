import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";

import { resolveDelegatedThreadOwner } from "./DelegatedThreadOwnership.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const OWNER = UserId.make("user-linear-starter");
const ACTOR = UserId.make("user-authenticated");
const createdAt = "2026-01-01T00:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

const directCreate = (ownerUserId?: UserId): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make("cmd-create"),
  threadId: ThreadId.make("thread-create"),
  projectId: ProjectId.make("project-1"),
  title: "Created thread",
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  sourceControlProfileId: null,
  ...(ownerUserId === undefined ? {} : { ownerUserId }),
  createdAt,
});

const bootstrapCreate = (ownerUserId?: UserId): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-bootstrap"),
  threadId: ThreadId.make("thread-bootstrap"),
  message: {
    messageId: MessageId.make("msg-bootstrap"),
    role: "user",
    text: "start",
    attachments: [],
  },
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project-1"),
      title: "Bootstrapped thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      sourceControlProfileId: null,
      ...(ownerUserId === undefined ? {} : { ownerUserId }),
      createdAt,
    },
  },
  createdAt,
});

it.layer(NodeServices.layer)("resolveDelegatedThreadOwner", (it) => {
  it("uses the authenticated actor instead of a supplied owner", () => {
    expect(resolveDelegatedThreadOwner(bootstrapCreate(OWNER), ACTOR)).toBe(ACTOR);
  });

  it("uses the supplied owner for actorless direct creation", () => {
    expect(resolveDelegatedThreadOwner(directCreate(OWNER), null)).toBe(OWNER);
  });

  it("uses the supplied owner for actorless bootstrapped creation", () => {
    expect(resolveDelegatedThreadOwner(bootstrapCreate(OWNER), null)).toBe(OWNER);
  });

  it("keeps actorless creation ownerless when ownerUserId is omitted", () => {
    expect(resolveDelegatedThreadOwner(bootstrapCreate(), null)).toBeNull();
  });

  it.effect("persists and projects the supplied owner through thread.created", () =>
    Effect.gen(function* () {
      const command = directCreate(OWNER);
      const readModel = {
        ...createEmptyReadModel(createdAt),
        projects: [
          {
            id: ProjectId.make("project-1"),
            title: "Project",
            workspaceRoot: "/tmp/project",
            defaultModelSelection: null,
            scripts: [],
            ownerUserId: null,
            memberUserIds: [],
            createdAt,
            updatedAt: createdAt,
            deletedAt: null,
          },
        ],
      };
      const actor = resolveDelegatedThreadOwner(command, null);
      const decided = yield* decideOrchestrationCommand({ command, readModel, actor });
      const event = Array.isArray(decided) ? decided[0] : decided;

      expect(event.type).toBe("thread.created");
      if (event.type !== "thread.created") return;
      expect(event.payload.createdByUserId).toBe(OWNER);

      const projected = yield* projectEvent(readModel, { ...event, sequence: 1 });
      expect(projected.threads[0]?.ownerUserId).toBe(OWNER);
    }),
  );
});
