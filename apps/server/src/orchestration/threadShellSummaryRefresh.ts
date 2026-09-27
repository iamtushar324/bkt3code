import type { OrchestrationEvent } from "@t3tools/contracts";

type ThreadShellSummaryEvent = Extract<
  OrchestrationEvent,
  {
    readonly type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested";
  }
>;

const summaryRelevantActivityKinds = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

export function shouldRefreshThreadShellSummary(event: ThreadShellSummaryEvent): boolean {
  switch (event.type) {
    case "thread.message-sent":
      return event.payload.role === "user";
    case "thread.proposed-plan-upserted":
    case "thread.approval-response-requested":
      return true;
    case "thread.activity-appended":
      return summaryRelevantActivityKinds.has(event.payload.activity.kind);
    case "thread.user-input-response-requested":
      return false;
  }
}
