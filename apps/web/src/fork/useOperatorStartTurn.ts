// T3-CUSTOM(expbkt3): every native run is persisted under the signed-in operator, so the
// durable outbox replays it for that operator after a reload or a reconnect. Upstream's send
// hooks each build their own startTurn command; this keeps the fork seam in each to one line.
import { useCurrentUserId } from "../state/identity";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

/** The outbox key for runs this client starts; "anonymous" when nobody is signed in. */
export function useOutboxIdentityKey(): string {
  return useCurrentUserId() ?? "anonymous";
}

/** `threadEnvironment.startTurn`, stamped with the operator's outbox identity. */
export function useOperatorStartTurn() {
  const sendThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });
  const outboxIdentityKey = useOutboxIdentityKey();
  return (target: Parameters<typeof sendThreadTurn>[0]) =>
    sendThreadTurn({ ...target, input: { ...target.input, outboxIdentityKey } });
}
