/**
 * T3-CUSTOM(expbkt3): decides whether an approval must re-send the plan body.
 *
 * The default answer is no — the model wrote the plan and still has it in
 * context, so repeating it wastes thousands of tokens per approval. We only
 * repeat it when the model demonstrably cannot see it any more.
 */

export interface PlanResendSignals {
  /**
   * ISO timestamp of the most recent `context-compaction` activity on the
   * thread, or null when the thread has never compacted.
   */
  readonly latestCompactionAt: string | null;
  /** ISO timestamp of the version the agent proposed. */
  readonly planCreatedAt: string;
  /** Thread the plan was authored in. */
  readonly planThreadId: string;
  /** Thread the implementation turn will start in. */
  readonly targetThreadId: string;
  /** Provider session status bound to the target thread, null when unbound. */
  readonly providerSessionStatus: string | null;
  /** How many versions of the plan the agent wrote. */
  readonly agentRevisionCount: number;
}

export interface PlanResendDecision {
  readonly shouldResend: boolean;
  /**
   * Human-readable clause completing "The full plan is repeated because …".
   * Null when nothing is resent.
   */
  readonly reason: string | null;
}

/**
 * Returns whether the approval prompt must carry the whole plan.
 *
 * Four signals force a resend; anything else keeps the prompt to one line.
 */
export function decidePlanResend(signals: PlanResendSignals): PlanResendDecision {
  if (signals.targetThreadId !== signals.planThreadId) {
    return {
      shouldResend: true,
      reason: "it is being implemented in a different session from the one that planned it",
    };
  }

  // Earlier revisions are still in context, and "the plan above" has been read
  // as one of them. Naming the approved text removes the ambiguity.
  if (signals.agentRevisionCount > 1) {
    return {
      shouldResend: true,
      reason: "the plan was revised, and only this revision is approved",
    };
  }

  if (signals.latestCompactionAt !== null && signals.latestCompactionAt > signals.planCreatedAt) {
    return {
      shouldResend: true,
      reason: "this session compacted its context after the plan was written",
    };
  }

  // A stopped or absent provider session means the next turn boots a fresh
  // process, which will not have replayed the planning turn.
  if (signals.providerSessionStatus === null || signals.providerSessionStatus === "stopped") {
    return {
      shouldResend: true,
      reason: "the planning session is no longer running",
    };
  }

  return { shouldResend: false, reason: null };
}
