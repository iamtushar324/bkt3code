/**
 * T3-CUSTOM(expbkt3): a question whose run already ended can be dismissed.
 *
 * When a run fails while the agent waits on a question, the question stays
 * pending with a live capability that no provider can answer. The server
 * answers such a question in message mode (`orphanedRuntimeRequest.expbkt3.ts`
 * in apps/server); this lets the composer offer Dismiss for it too, instead
 * of only a Submit that the dead turn never receives.
 */
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

// The server's rule (`runEndedWithoutAnswer`): a completed run's session stays live.
const ENDED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "interrupted", "cancelled"]);

export function releaseEndedRunUserInputs(
  pending: PendingThreadRequests,
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
): PendingThreadRequests {
  if (!pending.userInputs.some((input) => input.responseCapability === "live")) return pending;
  const endedRunIds = new Set(
    projection.runs.filter((run) => ENDED_RUN_STATUSES.has(run.status)).map((run) => run.id),
  );
  if (endedRunIds.size === 0) return pending;
  let changed = false;
  const userInputs = pending.userInputs.map((input) => {
    if (input.responseCapability !== "live") return input;
    const item = projection.turnItems.findLast(
      (candidate) =>
        candidate.type === "user_input_request" && candidate.requestId === input.requestId,
    );
    if (item?.runId == null || !endedRunIds.has(item.runId)) return input;
    changed = true;
    return {
      ...input,
      responseCapability: "message" as const,
      responseMode: "message" as const,
      dismissible: true,
    };
  });
  return changed ? { ...pending, userInputs } : pending;
}
