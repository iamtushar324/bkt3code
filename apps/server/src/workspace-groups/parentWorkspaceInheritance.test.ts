import { describe, expect, it } from "vite-plus/test";

import {
  resolveParentWorkspaceInheritance,
  shouldJoinParentWorkspaceGroup,
} from "./parentWorkspaceInheritance.ts";

const parent = {
  projectId: "project-bks",
  worktreePath: "/home/agent/worktrees/beknown-services/hongkong",
  branch: "bk-t3-code/tec-1360",
};

const base = {
  hasExplicitWorkspace: false,
  parentThreadId: "thread-parent",
  parent,
  targetProjectId: "project-bks",
};

describe("where a child session works", () => {
  it("uses the parent's own worktree in the parent's repository", () => {
    expect(resolveParentWorkspaceInheritance(base)).toEqual({
      kind: "parent-worktree",
      path: "/home/agent/worktrees/beknown-services/hongkong",
      branch: "bk-t3-code/tec-1360",
    });
  });

  it("uses the project checkout when the parent is not in a worktree", () => {
    expect(
      resolveParentWorkspaceInheritance({
        ...base,
        parent: { ...parent, worktreePath: null },
      }),
    ).toEqual({ kind: "parent-checkout" });
  });

  it("shares one group worktree per repository the parent fans out into", () => {
    expect(resolveParentWorkspaceInheritance({ ...base, targetProjectId: "project-bkd" })).toEqual({
      kind: "shared-group",
    });
  });

  it("leaves an explicit workspace alone, including a requested new worktree", () => {
    expect(resolveParentWorkspaceInheritance({ ...base, hasExplicitWorkspace: true })).toEqual({
      kind: "none",
    });
    expect(
      resolveParentWorkspaceInheritance({
        ...base,
        hasExplicitWorkspace: true,
        targetProjectId: "project-bkd",
      }),
    ).toEqual({ kind: "none" });
  });

  it("falls back to the defaults with no parent to inherit from", () => {
    expect(
      resolveParentWorkspaceInheritance({ ...base, parentThreadId: null, parent: null }),
    ).toEqual({ kind: "none" });
  });

  // An archived parent is absent from the active shell snapshot. Its worktree
  // may already have been reclaimed, so inheriting the path would hand the
  // child a directory nothing is keeping alive.
  it("falls back to the defaults when the parent row cannot be read", () => {
    expect(resolveParentWorkspaceInheritance({ ...base, parent: null })).toEqual({ kind: "none" });
  });
});

describe("reserving the parent's worktree for a repository", () => {
  it("claims a group for any parented request that named no workspace", () => {
    expect(
      shouldJoinParentWorkspaceGroup({ hasExplicitWorkspace: false, parentThreadId: "thread-a" }),
    ).toBe(true);
  });

  it("never claims one for an explicit request or a root session", () => {
    expect(
      shouldJoinParentWorkspaceGroup({ hasExplicitWorkspace: true, parentThreadId: "thread-a" }),
    ).toBe(false);
    expect(
      shouldJoinParentWorkspaceGroup({ hasExplicitWorkspace: false, parentThreadId: null }),
    ).toBe(false);
  });
});
