// T3-CUSTOM(expbkt3): sidebar "Create new thread" create-input coverage.
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNewThreadFromRowCreateInput,
  canCreateWorktreeFromParent,
  NEW_THREAD_FROM_ROW_TITLE,
  resolveSameWorktreeWorkspace,
  type NewThreadParentThread,
} from "./NewThreadFromRow.logic";

const CREATED_AT = "2026-08-10T12:00:00.000Z";
const NEW_THREAD_ID = ThreadId.make("thread-new");

function parent(overrides: Partial<NewThreadParentThread> = {}): NewThreadParentThread {
  return {
    id: ThreadId.make("thread-parent"),
    projectId: ProjectId.make("project-1"),
    branch: "feature/parent",
    worktreePath: "/home/dev/worktrees/repo/feature-parent",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    sourceControlProfileId: null,
    ...overrides,
  };
}

describe("buildNewThreadFromRowCreateInput", () => {
  it("parents the new thread and inherits the parent's model when no default is saved", () => {
    const input = buildNewThreadFromRowCreateInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      workspace: resolveSameWorktreeWorkspace(parent()),
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: CREATED_AT,
    });

    expect(input).toMatchObject({
      threadId: NEW_THREAD_ID,
      projectId: ProjectId.make("project-1"),
      parentThreadId: ThreadId.make("thread-parent"),
      title: NEW_THREAD_FROM_ROW_TITLE,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: CREATED_AT,
    });
  });

  it("starts with the saved default model, options included, and the saved starting mode", () => {
    const saved = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5",
      options: [{ id: "effort", value: "max" }],
    };
    const input = buildNewThreadFromRowCreateInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      workspace: resolveSameWorktreeWorkspace(parent()),
      modelSelection: saved,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdAt: CREATED_AT,
    });

    expect(input).toMatchObject({
      modelSelection: saved,
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
  });

  it("reuses the parent's worktree and branch for the same-worktree choice", () => {
    const input = buildNewThreadFromRowCreateInput({
      parent: parent(),
      threadId: NEW_THREAD_ID,
      workspace: resolveSameWorktreeWorkspace(parent()),
      modelSelection: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: CREATED_AT,
    });

    expect(input.worktreePath).toBe("/home/dev/worktrees/repo/feature-parent");
    expect(input.branch).toBe("feature/parent");
  });

  it("shares the project checkout when the parent has no worktree", () => {
    const workspace = resolveSameWorktreeWorkspace(parent({ worktreePath: null, branch: "main" }));

    expect(workspace).toEqual({ branch: "main", worktreePath: null });
  });
});

describe("canCreateWorktreeFromParent", () => {
  it("needs a parent branch to branch the new worktree from", () => {
    expect(canCreateWorktreeFromParent(parent())).toBe(true);
    expect(canCreateWorktreeFromParent(parent({ branch: null }))).toBe(false);
  });
});
