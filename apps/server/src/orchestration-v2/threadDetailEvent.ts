/**
 * Events that mutate the live thread-detail document delivered to clients.
 *
 * T3-CUSTOM(expbkt3): fork-owned membership events route through this list
 * too, so an already-open thread never goes stale when its audience changes.
 */
import type { OrchestrationEvent } from "@t3tools/contracts";

export type ThreadDetailEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.member-added"
      | "thread.member-removed"
      | "thread.owner-transferred";
  }
>;

export function isThreadDetailEvent(event: OrchestrationEvent): event is ThreadDetailEvent {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    event.type === "thread.member-added" ||
    event.type === "thread.member-removed" ||
    event.type === "thread.owner-transferred"
  );
}
