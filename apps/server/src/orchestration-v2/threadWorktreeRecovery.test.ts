/**
 * T3-CUSTOM(expbkt3): Coverage for the missing-worktree recovery decision.
 *
 * The decision runs on every session start for a thread whose worktree
 * directory has vanished, so each branch is asserted directly: the recoverable
 * case must recreate in place, and every unrecoverable case must phrase its
 * detail so `durableRecoveryFailure` treats the failure as permanent.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  decideWorktreeRecovery,
  describeWorktreeRecreation,
  type WorktreeRecoveryFacts,
} from "./threadWorktreeRecovery.ts";

const WORKTREE = "/home/ubuntu/.t3/dev/worktrees/proj/t3code-abc123";
const WORKSPACE_ROOT = "/home/ubuntu/repos/proj";
const BRANCH = "t3code/feature";

const facts = (overrides: Partial<WorktreeRecoveryFacts> = {}): WorktreeRecoveryFacts => ({
  worktreePath: WORKTREE,
  branch: BRANCH,
  branchExists: true,
  workspaceRoot: WORKSPACE_ROOT,
  ...overrides,
});

/** The permanent-failure patterns from `durableRecoveryFailure`. */
const readsAsPermanent = (detail: string) =>
  /worktree.*(?:does not exist|not found|missing)/.test(detail.toLowerCase());

describe("decideWorktreeRecovery", () => {
  it("recreates in place when the branch survived the deletion", () => {
    expect(decideWorktreeRecovery(facts())).toEqual({
      kind: "recreate",
      workspaceRoot: WORKSPACE_ROOT,
      branch: BRANCH,
      worktreePath: WORKTREE,
    });
  });

  it("is unrecoverable when the branch is gone too", () => {
    const decision = decideWorktreeRecovery(facts({ branchExists: false }));
    if (decision.kind !== "unrecoverable") {
      throw new Error("expected an unrecoverable decision");
    }
    expect(decision.detail).toContain(BRANCH);
    expect(readsAsPermanent(decision.detail)).toBe(true);
  });

  it("is unrecoverable when the thread never recorded a branch", () => {
    const decision = decideWorktreeRecovery(facts({ branch: null, branchExists: false }));
    if (decision.kind !== "unrecoverable") {
      throw new Error("expected an unrecoverable decision");
    }
    expect(readsAsPermanent(decision.detail)).toBe(true);
  });

  it("is unrecoverable when the project workspace root is unknown", () => {
    const decision = decideWorktreeRecovery(facts({ workspaceRoot: null }));
    if (decision.kind !== "unrecoverable") {
      throw new Error("expected an unrecoverable decision");
    }
    expect(readsAsPermanent(decision.detail)).toBe(true);
  });
});

describe("describeWorktreeRecreation", () => {
  it("names the recreated path, the branch, and the data-loss caveat", () => {
    const detail = describeWorktreeRecreation({ worktreePath: WORKTREE, branch: BRANCH });
    expect(detail).toContain(WORKTREE);
    expect(detail).toContain(BRANCH);
    expect(detail.toLowerCase()).toContain("uncommitted");
  });
});
