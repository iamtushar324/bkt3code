/**
 * T3-CUSTOM(expbkt3): adapter continuations under a held queue.
 *
 * Stop holds a thread's queued runs until the user resumes the queue, and a
 * message queued behind a held run copies the hold, so user messages keep
 * their order. An adapter continuation is different: ProviderContinuationService
 * dispatches it when the provider CLI started a turn by itself (a background
 * command finished, a subagent reported), and the adapter buffers that output
 * until the continuation run starts. Holding it strands output the CLI already
 * produced, so it never copies the hold, and the queue starts it while the
 * held runs keep waiting for the user.
 */
import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";

/**
 * True for the message.dispatch ProviderContinuationService sends for an
 * adapter-buffered wake. A message_text wake is server-created and has no
 * buffered output, so it follows the normal queue rules.
 */
export function isAdapterContinuationDispatch(command: {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}): boolean {
  return command.createdBy === "agent" && command.creationSource === "provider";
}

/**
 * The queued run the queue starts next: the first in delivery order that the
 * user has not held. Only adapter continuations are unheld behind held runs.
 */
export function nextStartableQueuedRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): OrchestrationV2Run | undefined {
  return queuedRunsInDeliveryOrder(projection).find((run) => run.queueHeld !== true);
}
