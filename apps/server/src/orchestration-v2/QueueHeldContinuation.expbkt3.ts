/**
 * T3-CUSTOM(expbkt3): adapter continuations under a held queue.
 *
 * Stop holds a thread's queued runs until the user resumes the queue or sends a
 * message from a client (upstream #21473), and any other message queued behind a
 * held run copies the hold, so messages keep their order. An adapter
 * continuation is different: ProviderContinuationService
 * dispatches it when the provider reported background work while no turn was
 * open. Claude, ACP and OpenCode buffer the output their CLI already produced
 * until the continuation run starts; holding it strands that output (and the
 * adapter's one pending continuation blocks every later wake). So it never
 * copies the hold, and the queue starts it while the held runs keep waiting
 * for the user.
 *
 * Codex has no buffer: its continuation text is a real prompt. It gets the same
 * treatment, matching a continuation that arrives with no active run, which
 * already starts past a held queue.
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
