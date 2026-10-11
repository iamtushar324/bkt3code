/**
 * T3-CUSTOM(expbkt3): whether a session waits on a person, and for what.
 *
 * The sidebar badges a session by the same rule
 * (`resolvePhaseSidebarAttentionKind`): a blocking question, then an approval,
 * then an async question, then a failure, then a plan that is ready to
 * decide. Agents that read sessions over MCP use this function, so an agent
 * and the people in the app agree on what waits. An auth refresh is the
 * provider's own sign-in, not an approval a person gives, and a failure or a
 * plan counts only once the agent has stopped working.
 */
export type SessionAttentionKind = "question" | "approval" | "async-question" | "failed" | "plan";

export interface SessionAttentionInput {
  /** Kind of the open runtime request, or null when none is open. */
  readonly pendingRequestKind: string | null;
  readonly hasPendingAsyncUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  /** A run is preparing, starting, running or waiting. */
  readonly agentActive: boolean;
  /** The latest run failed. */
  readonly failed: boolean;
}

export function classifySessionAttention(
  input: SessionAttentionInput,
): SessionAttentionKind | null {
  if (input.pendingRequestKind === "user_input") return "question";
  if (input.pendingRequestKind !== null && input.pendingRequestKind !== "auth_refresh") {
    return "approval";
  }
  if (input.hasPendingAsyncUserInput) return "async-question";
  if (input.agentActive) return null;
  if (input.failed) return "failed";
  if (input.hasActionableProposedPlan) return "plan";
  return null;
}
