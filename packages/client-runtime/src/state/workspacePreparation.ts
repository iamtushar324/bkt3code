// T3-CUSTOM(expbkt3): chat-visible checklist for durable new-thread workspace preparation.
import type { ThreadExecutionIntent, ThreadExecutionIntentBootstrap } from "@t3tools/contracts";

export type WorkspacePreparationStepKey = "worktree" | "setup" | "agent";
export type WorkspacePreparationStepStatus = "pending" | "running" | "done" | "skipped" | "failed";

export interface WorkspacePreparationStep {
  readonly key: WorkspacePreparationStepKey;
  readonly status: WorkspacePreparationStepStatus;
  readonly label: string;
}

export interface WorkspacePreparationView {
  /** `preparing` until worktree and setup settle; `ready` once only the agent remains. */
  readonly state: "preparing" | "ready" | "failed";
  /** One-line summary: the running step while preparing, else the outcome. */
  readonly label: string;
  readonly steps: ReadonlyArray<WorkspacePreparationStep>;
  /** True once the agent has the prompt; "Thinking" is only honest from here on. */
  readonly agentStarted: boolean;
  readonly setupTerminalId: string | null;
  readonly failureDetail: string | null;
}

type BootstrapPhase = ThreadExecutionIntentBootstrap["worktreePhase"];

const STEP_LABELS = {
  worktree: {
    pending: "Create worktree",
    running: "Creating worktree…",
    done: "Worktree created",
    skipped: "Using existing workspace",
    failed: "Worktree creation failed",
  },
  setup: {
    pending: "Run setup script",
    running: "Running setup script…",
    done: "Setup script finished",
    skipped: "No setup needed",
    failed: "Setup script failed",
  },
  agent: {
    pending: "Start agent",
    running: "Starting agent…",
    done: "Agent started",
    skipped: "Agent not requested",
    failed: "Agent failed to start",
  },
} as const satisfies Record<
  WorkspacePreparationStepKey,
  Record<WorkspacePreparationStepStatus, string>
>;

function stepStatus(phase: BootstrapPhase): WorkspacePreparationStepStatus {
  switch (phase) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "acknowledged":
      return "done";
    case "not-required":
      return "skipped";
    case "failed":
    case "uncertain":
      return "failed";
  }
}

const AGENT_STARTED_PHASES = new Set<ThreadExecutionIntent["phase"]>([
  "running",
  "waiting-for-approval",
  "waiting-for-input",
]);

/**
 * Derives the workspace checklist from the durable execution intent. Returns
 * null when the turn prepares nothing (local or existing workspace, no setup)
 * or the user stopped it, so ordinary turns keep their usual working row.
 */
export function deriveWorkspacePreparation(
  intent: Pick<ThreadExecutionIntent, "desiredState" | "phase" | "bootstrap"> | null | undefined,
): WorkspacePreparationView | null {
  const bootstrap = intent?.bootstrap;
  if (!intent || !bootstrap || intent.desiredState !== "running") return null;
  if (bootstrap.worktreePhase === "not-required" && bootstrap.setupPhase === "not-required") {
    return null;
  }

  let worktree = stepStatus(bootstrap.worktreePhase);
  let setup = stepStatus(bootstrap.setupPhase);
  // Step transitions inside one preparation pass are not all published, so the
  // first unfinished step is the one the server is working on.
  if (worktree === "pending") worktree = "running";
  else if (worktree !== "failed" && setup === "pending") setup = "running";

  const failed = worktree === "failed" || setup === "failed";
  const preparing = !failed && (worktree === "running" || setup === "running");
  const agentStarted = AGENT_STARTED_PHASES.has(intent.phase);
  const agent: WorkspacePreparationStepStatus =
    failed || preparing ? "pending" : agentStarted ? "done" : "running";

  const steps: WorkspacePreparationStep[] = [
    { key: "worktree", status: worktree, label: STEP_LABELS.worktree[worktree] },
    { key: "setup", status: setup, label: STEP_LABELS.setup[setup] },
    { key: "agent", status: agent, label: STEP_LABELS.agent[agent] },
  ];
  const current = steps.find((step) => step.status === "running" || step.status === "failed");

  return {
    state: failed ? "failed" : preparing ? "preparing" : "ready",
    label: failed
      ? (current?.label ?? "Workspace setup failed")
      : preparing
        ? (current?.label ?? "Setting up workspace…")
        : "Workspace ready",
    steps,
    agentStarted,
    // The id is allocated up front; it only names a terminal once setup has launched.
    setupTerminalId:
      setup === "skipped" || bootstrap.setupPhase === "pending" ? null : bootstrap.setupTerminalId,
    failureDetail: bootstrap.failureDetail,
  };
}
