// T3-CUSTOM(expbkt3): a question or approval that outlived the provider that asked it.
/**
 * A provider question (Claude's AskUserQuestion) or approval is answered live:
 * the answer goes back to the callback the provider is blocked on. When the run
 * fails instead (the provider stream closes, an event fails to ingest), the run
 * ends and its provider session is detached, but the request stays `pending`
 * with a `live` capability that nothing can reach. Answering it then fails
 * ("Provider session … was not found"), dismissing it fails ("This question
 * needs an answer"), and Stop is gone because the run already ended.
 *
 * Such a request is handled the way a message-mode question is: an answer is
 * recorded and reaches the agent as the next message, a dismissal closes it, and
 * an approval closes without a reply, since no provider can act on it now.
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type {
  ProjectionRuntimeResponseContext,
  ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

/** Run states after which no turn of the run waits for an answer. */
const ENDED_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

/** Whether a pending live request can no longer reach the provider that asked it. */
export function isOrphanedRuntimeRequest(input: {
  readonly request: OrchestrationV2RuntimeRequest;
  readonly sessionBound: boolean;
  readonly runStatus: OrchestrationV2Run["status"] | undefined;
}): boolean {
  return (
    input.request.status === "pending" &&
    input.request.responseCapability.type === "live" &&
    (!input.sessionBound ||
      (input.runStatus !== undefined && ENDED_RUN_STATUSES.has(input.runStatus)))
  );
}

/**
 * The request as a response should treat it: unchanged while its provider can
 * still answer, else in message mode. The run is read only when the session is
 * still bound, which is the uncommon case.
 */
export const respondableRuntimeRequest = (input: {
  readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">;
  readonly threadId: ThreadId;
  readonly context: ProjectionRuntimeResponseContext;
}) =>
  Effect.gen(function* () {
    const { request, node, session } = input.context;
    if (request === undefined || request.status !== "pending") return request;
    if (request.responseCapability.type !== "live") return request;
    let runStatus: OrchestrationV2Run["status"] | undefined;
    const runId = node?.runId ?? null;
    if (session !== undefined && runId !== null) {
      const { runs } = yield* input.projectionStore.getThreadRecords(input.threadId, ["runs"]);
      runStatus = runs.find((run) => run.id === runId)?.status;
    }
    return isOrphanedRuntimeRequest({ request, sessionBound: session !== undefined, runStatus })
      ? { ...request, responseCapability: { type: "message" as const } }
      : request;
  });

/** One question's answer as message text; a multi-select answer lists its choices. */
export function messageAnswerText(answer: unknown): unknown {
  if (!Array.isArray(answer)) return answer;
  const choices = answer.filter(
    (choice): choice is string => typeof choice === "string" && choice.trim().length > 0,
  );
  return choices.length === 0 ? undefined : choices.map((choice) => choice.trim()).join(", ");
}
