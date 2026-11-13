/** T3-CUSTOM(expbkt3): one-line summary of a server's session callbacks for BK Add-ons. */
import {
  sessionCallbackEvents,
  sessionWebhookRemovedIssues,
} from "@t3tools/client-runtime/bk-session-callback-presentation";
import type { SessionWebhookView } from "@t3tools/contracts";

export interface SessionWebhookSummary {
  readonly total: number;
  readonly counts: Readonly<Record<SessionWebhookView["status"], number>>;
  /** Webhooks with a sync failure, missing Toolyard history, or a failed or stopped event. */
  readonly needsAttention: number;
}

export function summarizeSessionWebhooks(
  webhooks: ReadonlyArray<SessionWebhookView>,
): SessionWebhookSummary {
  const counts = { registering: 0, active: 0, disabled: 0, removed: 0 };
  let needsAttention = 0;
  for (const webhook of webhooks) {
    counts[webhook.status] += 1;
    // The removed-webhook issue list is the same three checks the cards show for any webhook.
    // A removed webhook's old failed deliveries cannot be acted on any more, so for it only
    // its own sync state counts; otherwise the warning would stay for good.
    const events = webhook.status === "removed" ? [] : sessionCallbackEvents(webhook);
    if (sessionWebhookRemovedIssues(webhook, events).length > 0) needsAttention += 1;
  }
  return { total: webhooks.length, counts, needsAttention };
}

/** "2 active · 1 removed", or a plain sentence when there are none. */
export function sessionWebhookCountsText(summary: SessionWebhookSummary): string {
  if (summary.total === 0) return "No session callbacks yet";
  const parts = (["active", "registering", "disabled", "removed"] as const)
    .filter((status) => summary.counts[status] > 0)
    .map((status) => `${summary.counts[status]} ${status}`);
  const total = summary.total === 1 ? "1 callback" : `${summary.total} callbacks`;
  return `${total}: ${parts.join(" · ")}`;
}

export function sessionWebhookAttentionText(summary: SessionWebhookSummary): string | null {
  if (summary.needsAttention === 0) return null;
  return summary.needsAttention === 1
    ? "1 webhook needs attention"
    : `${summary.needsAttention} webhooks need attention`;
}
