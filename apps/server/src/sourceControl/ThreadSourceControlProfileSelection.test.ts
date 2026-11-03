import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  SourceControlProfileId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyAssignedSourceControlProfile } from "./ThreadSourceControlProfileSelection.ts";

const assignedProfileId = SourceControlProfileId.make("github_alice");
const explicitProfileId = SourceControlProfileId.make("github_bob");
const createdAt = "2026-08-01T00:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6",
};

const createThreadCommand = (sourceControlProfileId: SourceControlProfileId | null) =>
  ({
    type: "thread.create",
    commandId: CommandId.make("command-create"),
    threadId: ThreadId.make("thread-create"),
    projectId: ProjectId.make("project-1"),
    title: "New thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    sourceControlProfileId,
    createdAt,
  }) satisfies OrchestrationCommand;

const bootstrapTurnCommand = (sourceControlProfileId: SourceControlProfileId | null) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("command-turn"),
    threadId: ThreadId.make("thread-turn"),
    message: {
      messageId: MessageId.make("message-1"),
      role: "user",
      text: "Start work",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    bootstrap: {
      createThread: {
        projectId: ProjectId.make("project-1"),
        title: "New thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        sourceControlProfileId,
        createdAt,
      },
    },
    createdAt,
  }) satisfies OrchestrationCommand;

describe("applyAssignedSourceControlProfile", () => {
  it("fills a missing owner on direct thread creation", () => {
    const command = applyAssignedSourceControlProfile(createThreadCommand(null), assignedProfileId);

    expect(command.type).toBe("thread.create");
    if (command.type === "thread.create") {
      expect(command.sourceControlProfileId).toBe(assignedProfileId);
    }
  });

  it("fills a missing owner on bootstrapped first-turn creation", () => {
    const command = applyAssignedSourceControlProfile(
      bootstrapTurnCommand(null),
      assignedProfileId,
    );

    expect(command.type).toBe("thread.turn.start");
    if (command.type === "thread.turn.start") {
      expect(command.bootstrap?.createThread?.sourceControlProfileId).toBe(assignedProfileId);
    }
  });

  it("overrides an explicit profile with the creator's assigned profile", () => {
    const command = applyAssignedSourceControlProfile(
      createThreadCommand(explicitProfileId),
      assignedProfileId,
    );

    expect(command.type).toBe("thread.create");
    if (command.type === "thread.create") {
      expect(command.sourceControlProfileId).toBe(assignedProfileId);
    }
  });

  it("leaves creation unowned when the authenticated user has no assignment", () => {
    const command = applyAssignedSourceControlProfile(createThreadCommand(null), null);

    expect(command.type).toBe("thread.create");
    if (command.type === "thread.create") {
      expect(command.sourceControlProfileId).toBeNull();
    }
  });

  it("rejects a client-selected profile when there is no authenticated user assignment", () => {
    const command = applyAssignedSourceControlProfile(createThreadCommand(explicitProfileId), null);

    expect(command.type).toBe("thread.create");
    if (command.type === "thread.create") {
      expect(command.sourceControlProfileId).toBeNull();
    }
  });
});
