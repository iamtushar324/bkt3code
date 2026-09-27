import type { ThreadExecutionIntentBootstrap } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { deriveWorkspacePreparation } from "./workspacePreparation.ts";

const bootstrap = (
  overrides: Partial<ThreadExecutionIntentBootstrap> = {},
): ThreadExecutionIntentBootstrap => ({
  workspaceMode: "new-worktree",
  base: "origin/main",
  intendedPath: "/worktrees/repo/zurich",
  newBranch: "t3code/zurich",
  worktreePhase: "pending",
  setupPhase: "pending",
  failureDetail: null,
  setupTerminalId: "setup-work-1",
  ...overrides,
});

const statuses = (view: ReturnType<typeof deriveWorkspacePreparation>) =>
  view?.steps.map((step) => `${step.key}:${step.status}`);

describe("workspace preparation", () => {
  it("shows worktree creation as the running step before anything is acknowledged", () => {
    const view = deriveWorkspacePreparation({
      desiredState: "running",
      phase: "preparing",
      bootstrap: bootstrap(),
    });
    expect(view?.state).toBe("preparing");
    expect(view?.label).toBe("Creating worktree…");
    expect(view?.agentStarted).toBe(false);
    expect(view?.setupTerminalId).toBeNull();
    expect(statuses(view)).toEqual(["worktree:running", "setup:pending", "agent:pending"]);
  });

  it("moves on to the setup script once the worktree exists", () => {
    const view = deriveWorkspacePreparation({
      desiredState: "running",
      phase: "preparing",
      bootstrap: bootstrap({ worktreePhase: "acknowledged", setupPhase: "running" }),
    });
    expect(view?.label).toBe("Running setup script…");
    expect(view?.setupTerminalId).toBe("setup-work-1");
    expect(statuses(view)).toEqual(["worktree:done", "setup:running", "agent:pending"]);
  });

  it("is ready but not thinking while the provider session starts", () => {
    const view = deriveWorkspacePreparation({
      desiredState: "running",
      phase: "starting",
      bootstrap: bootstrap({ worktreePhase: "acknowledged", setupPhase: "acknowledged" }),
    });
    expect(view?.state).toBe("ready");
    expect(view?.label).toBe("Workspace ready");
    expect(view?.agentStarted).toBe(false);
    expect(statuses(view)).toEqual(["worktree:done", "setup:done", "agent:running"]);
  });

  it("marks the agent started once the turn runs", () => {
    const view = deriveWorkspacePreparation({
      desiredState: "running",
      phase: "running",
      bootstrap: bootstrap({ worktreePhase: "acknowledged", setupPhase: "acknowledged" }),
    });
    expect(view?.agentStarted).toBe(true);
    expect(statuses(view)).toEqual(["worktree:done", "setup:done", "agent:done"]);
  });

  it("reports a failed setup with its detail and terminal", () => {
    const view = deriveWorkspacePreparation({
      desiredState: "running",
      phase: "recovery-exhausted",
      bootstrap: bootstrap({
        worktreePhase: "acknowledged",
        setupPhase: "failed",
        failureDetail: "The setup script completed with a failure.",
      }),
    });
    expect(view?.state).toBe("failed");
    expect(view?.label).toBe("Setup script failed");
    expect(view?.failureDetail).toBe("The setup script completed with a failure.");
    expect(view?.setupTerminalId).toBe("setup-work-1");
    expect(statuses(view)).toEqual(["worktree:done", "setup:failed", "agent:pending"]);
  });

  it("stays out of the way for turns that prepare nothing or were stopped", () => {
    const nothing = bootstrap({
      workspaceMode: "local",
      worktreePhase: "not-required",
      setupPhase: "not-required",
    });
    expect(
      deriveWorkspacePreparation({ desiredState: "running", phase: "running", bootstrap: nothing }),
    ).toBeNull();
    expect(
      deriveWorkspacePreparation({
        desiredState: "stopped",
        phase: "stopping",
        bootstrap: bootstrap(),
      }),
    ).toBeNull();
    expect(deriveWorkspacePreparation(null)).toBeNull();
  });

  it("hides the setup terminal when an existing workspace needed no setup", () => {
    const view = deriveWorkspacePreparation({
      desiredState: "running",
      phase: "preparing",
      bootstrap: bootstrap({ workspaceMode: "existing-worktree", setupPhase: "not-required" }),
    });
    expect(view?.setupTerminalId).toBeNull();
    expect(statuses(view)).toEqual(["worktree:running", "setup:skipped", "agent:pending"]);
  });
});
