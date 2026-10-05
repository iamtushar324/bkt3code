/** T3-CUSTOM(expbkt3): shared session callback presentation for web and mobile settings. */
import type { SessionWebhookDeliveryHistory, SessionWebhookView } from "@t3tools/contracts";

/** Toolyard → server: Toolyard's own delivery record for one event. */
export type SessionCallbackTransportRecord = SessionWebhookDeliveryHistory;
/** Server → session: this server's durable receipt and dispatch record for one event. */
export type SessionCallbackDispatchRecord = SessionWebhookView["deliveries"][number];
export type SessionCallbackAttempt = SessionCallbackTransportRecord["history"][number];

export interface SessionCallbackEvent {
  readonly eventId: string;
  readonly transport: SessionCallbackTransportRecord | null;
  readonly dispatch: SessionCallbackDispatchRecord | null;
  /**
   * Failed, stopped or retrying without reaching the session. Events a confirmed Disable or
   * Remove stopped are deliberate outcomes, not failures: they stay listed but unresolved.
   */
  readonly needsAttention: boolean;
  /** Both reported stages completed. Missing or conflicting history remains incomplete. */
  readonly resolved: boolean;
}

export type SessionCallbackTone = "success" | "warning" | "error" | "info" | "neutral";

export interface SessionCallbackLabel {
  readonly text: string;
  readonly tone: SessionCallbackTone;
}

export interface SessionCallbackSessionName {
  readonly text: string;
  /** True when no authorized title is loaded in this client. */
  readonly fallback: boolean;
}

/** Reason codes a confirmed Disable or Remove writes; the user chose these outcomes. */
const deliberateStops: ReadonlySet<string> = new Set(["disable", "remove"]);

const reasons: Readonly<Record<string, string>> = {
  // Server → session dispatch outcomes.
  "destination-paused-or-archived": "Session paused, snoozed, archived or stopped",
  "destination-unauthorized-or-deleted": "Session deleted or no longer accessible to you",
  "destination-busy": "Session busy",
  "dispatch-rejected": "The session rejected the notification",
  "dispatch-retry-limit": "Stopped after the dispatch retry limit",
  "webhook-disabled-or-removed": "Webhook disabled or removed",
  "integration-disabled-or-replaced": "Toolyard integration disabled or replaced",
  "owner-disabled": "Your Toolyard connection is disabled",
  disable: "Webhook disabled",
  remove: "Webhook removed",
  // Webhook lifecycle.
  "secret-rotation-pending": "Secret rotation waiting for Toolyard sync",
  "rotate-server-sync-pending": "Secret rotation waiting for Toolyard sync; the server retries",
  "rotate-server-sync-failed":
    "Secret rotation could not sync with Toolyard; the server stopped retrying",
  "disable-server-sync-pending": "Disable waiting for Toolyard sync; the server retries",
  "disable-server-sync-failed": "Disable could not sync with Toolyard; the server stopped retrying",
  "remove-server-sync-pending": "Removal waiting for Toolyard sync; the server retries",
  "remove-server-sync-failed": "Removal could not sync with Toolyard; the server stopped retrying",
  // Toolyard → server transport.
  network_error: "No HTTP response (network error)",
  http_error: "Error HTTP response",
  timeout: "Timed out without a response",
  retry_limit: "Stopped after Toolyard's retry limit",
  // History reads.
  "delivery-history-unavailable": "Toolyard did not return its delivery history in time",
};

/** Plain explanation for a known reason code. Unknown codes are returned verbatim. */
export function sessionCallbackReason(code: string | null): string {
  if (code === null || code.trim() === "") return "No reason recorded";
  return Object.hasOwn(reasons, code) ? reasons[code]! : code;
}

const changeFailures: Readonly<Record<string, string>> = {
  "webhook-revision-conflict":
    "The webhook changed since this view loaded. Refresh, check its state, then try again.",
  // The server may have stopped retrying, so this never promises a retry.
  "webhook-server-sync-pending":
    "An earlier change has not synced with Toolyard. Refresh the callback status to see whether the server is still retrying or has stopped.",
  "webhook-disabled-or-update-pending": "The webhook is disabled, removed or already changing.",
  "webhook-not-found": "This webhook no longer exists for your account.",
  "rotation-key-unavailable": "The new secret was not available. Nothing was rotated.",
  "owner-disabled": "Your Toolyard connection is disabled on this server.",
  verified_identity_required: "Sign in with a verified identity to manage callbacks.",
};

/** Message for a failed Rotate/Disable/Remove. Unknown failure text is never reflected. */
export function sessionWebhookChangeFailureMessage(code: string | null): string {
  return (
    (code && Object.hasOwn(changeFailures, code) && changeFailures[code]) ||
    "The change did not apply. Refresh the callback status before another attempt."
  );
}

export function sessionWebhookLifecycleLabel(
  status: SessionWebhookView["status"],
): SessionCallbackLabel {
  switch (status) {
    case "registering":
      return { text: "Registering", tone: "info" };
    case "active":
      return { text: "Active", tone: "neutral" };
    case "disabled":
      return { text: "Disabled", tone: "warning" };
    case "removed":
      return { text: "Removed", tone: "neutral" };
  }
}

export type SessionWebhookAction = "rotate" | "disable" | "remove";

export interface SessionWebhookChangeConfirmation {
  readonly title: string;
  readonly description: string;
  readonly confirm: string;
  readonly busy: string;
}

/** Confirmation copy shared by web and mobile, so both describe the same server behaviour. */
export function sessionWebhookChangeConfirmation(
  action: SessionWebhookAction,
  sessionName: string,
): SessionWebhookChangeConfirmation {
  switch (action) {
    case "rotate":
      return {
        title: `Rotate the secret for ${sessionName}?`,
        description:
          "This server creates a new signing secret and syncs it with Toolyard. Until Toolyard confirms, the server accepts both secrets. After the switch, the previous secret keeps working for five minutes. If Toolyard cannot be reached, the server retries the sync for a limited time and this card shows whether it is pending or has failed. Queued events are not affected.",
        confirm: "Rotate secret",
        busy: "Rotating…",
      };
    case "disable":
      return {
        title: `Disable callbacks for ${sessionName}?`,
        description:
          "Toolyard is asked to stop sending decisions to this session. If Toolyard cannot be reached, the server retries that sync for a limited time and this card shows whether it is pending or has failed. Events not yet posted to the session stop and will not be posted. Settings cannot enable this webhook again; an agent must create a new one for the session.",
        confirm: "Disable",
        busy: "Disabling…",
      };
    case "remove":
      return {
        title: `Remove the webhook for ${sessionName}?`,
        description:
          "The webhook secret is deleted from this server and Toolyard is asked to remove the webhook. If Toolyard cannot be reached, the server retries that sync for a limited time and the removed webhook shows whether it is pending or has failed. Events not yet posted to the session stop and will not be posted. This cannot be undone from settings; an agent must create a new webhook. This server's delivery records stay visible here.",
        confirm: "Remove",
        busy: "Removing…",
      };
  }
}

const lifecycleNotices: Readonly<Record<string, SessionCallbackLabel>> = {
  "secret-rotation-pending": {
    text: "Secret rotation is syncing with Toolyard. The server accepts both secrets until Toolyard confirms.",
    tone: "info",
  },
  "rotate-server-sync-pending": {
    text: "Secret rotation has not reached Toolyard yet. The server keeps retrying and accepts both secrets until Toolyard confirms. Other changes wait until it finishes.",
    tone: "info",
  },
  "rotate-server-sync-failed": {
    text: "Secret rotation could not sync with Toolyard, and the server stopped retrying. Toolyard may still sign with the previous secret. Settings cannot change this webhook while the rotation is unresolved.",
    tone: "error",
  },
  "disable-server-sync-pending": {
    text: "Disabled on this server, but Toolyard has not confirmed yet. The server keeps retrying. Callbacks that arrive meanwhile are not posted to the session.",
    tone: "info",
  },
  "disable-server-sync-failed": {
    text: "Disable could not sync with Toolyard, and the server stopped retrying. Toolyard may keep sending callbacks; this server does not post them to the session. Settings cannot change this webhook while the disable is unresolved.",
    tone: "error",
  },
  "remove-server-sync-pending": {
    text: "Removed from this server, but Toolyard has not confirmed yet. The server keeps retrying. Callbacks that arrive meanwhile are not posted to the session.",
    tone: "info",
  },
  "remove-server-sync-failed": {
    text: "Removal could not sync with Toolyard, and the server stopped retrying. Toolyard may keep sending callbacks; this server does not post them to the session.",
    tone: "error",
  },
};

/**
 * Always-visible lifecycle state: info while a change syncs, error once the server stops
 * retrying. A completed Disable or Remove needs no notice; other reasons stay neutral text.
 */
export function sessionWebhookLifecycleNotice(
  webhook: SessionWebhookView,
): SessionCallbackLabel | null {
  const code = webhook.terminalReason;
  if (code === null || deliberateStops.has(code)) return null;
  if (Object.hasOwn(lifecycleNotices, code)) return lifecycleNotices[code]!;
  return { text: sessionCallbackReason(code), tone: "neutral" };
}

/** Authorized session title when loaded; otherwise an honest short-ID fallback. */
export function sessionCallbackSessionName(
  threadId: string,
  title: string | null | undefined,
): SessionCallbackSessionName {
  const trimmed = title?.trim();
  if (trimmed) return { text: trimmed, fallback: false };
  return {
    text: `Session ${threadId.length > 8 ? `${threadId.slice(0, 8)}…` : threadId}`,
    fallback: true,
  };
}

/** Always-visible warning when Toolyard's side of the history is missing or partial. */
export function sessionCallbackHistoryWarning(webhook: SessionWebhookView): string | null {
  if (webhook.deliveryHistoryError)
    return `Toolyard delivery history is unavailable: ${sessionCallbackReason(webhook.deliveryHistoryError)}. Server records are shown; Toolyard's delivery stage is unknown.`;
  if (webhook.callbackRef === null) return null;
  if (webhook.deliveryHistory === undefined)
    return "This server did not return Toolyard delivery history. Server records are shown; Toolyard's delivery stage is unknown.";
  return null;
}

/** Events a failure badge counts. Deliberate Disable/Remove stops are not counted. */
export function sessionCallbackAttentionCount(events: ReadonlyArray<SessionCallbackEvent>): number {
  return events.filter((event) => event.needsAttention).length;
}

/**
 * Issues a removed webhook must surface outside its collapsed section: sync state, missing
 * Toolyard history and failed or stopped events.
 */
export function sessionWebhookRemovedIssues(
  webhook: SessionWebhookView,
  events: ReadonlyArray<SessionCallbackEvent>,
): ReadonlyArray<SessionCallbackLabel> {
  const issues: Array<SessionCallbackLabel> = [];
  const lifecycle = sessionWebhookLifecycleNotice(webhook);
  if (lifecycle && lifecycle.tone !== "neutral") issues.push(lifecycle);
  const historyWarning = sessionCallbackHistoryWarning(webhook);
  if (historyWarning) issues.push({ text: historyWarning, tone: "warning" });
  const attention = sessionCallbackAttentionCount(events);
  if (attention > 0)
    issues.push({
      text: `Its history has ${attention} failed or stopped ${attention === 1 ? "event" : "events"}.`,
      tone: "warning",
    });
  return issues;
}

export function sessionCallbackAttempts(
  record: SessionCallbackTransportRecord,
): ReadonlyArray<SessionCallbackAttempt> {
  return [...record.history].sort((left, right) => left.attempt - right.attempt);
}

const lastAttempt = (record: SessionCallbackTransportRecord) =>
  sessionCallbackAttempts(record).at(-1) ?? null;

const attemptsText = (count: number) => `${count} ${count === 1 ? "attempt" : "attempts"}`;

const responseText = (attempt: SessionCallbackAttempt | null) =>
  attempt === null
    ? null
    : attempt.httpStatus === null
      ? "No HTTP response"
      : `HTTP ${attempt.httpStatus}`;

/** Toolyard → server stage. Never implies the session received the event. */
export function callbackTransportLabel(
  record: SessionCallbackTransportRecord | null,
  historyAvailable = true,
): SessionCallbackLabel {
  if (record === null)
    return historyAvailable
      ? { text: "No Toolyard delivery record", tone: "neutral" }
      : { text: "Toolyard history unavailable", tone: "neutral" };
  const last = lastAttempt(record);
  const parts = (head: string, ...rest: Array<string | null>) =>
    [head, ...rest.filter((part): part is string => part !== null)].join(" · ");
  switch (record.status) {
    case "delivered":
      return {
        text: parts(
          "Received",
          record.attempts > 1 ? attemptsText(record.attempts) : null,
          responseText(last),
        ),
        tone: "success",
      };
    case "failed":
      return {
        text: parts(
          "Stopped",
          attemptsText(record.attempts),
          responseText(last),
          record.terminalReason === null ? null : sessionCallbackReason(record.terminalReason),
        ),
        tone: "error",
      };
    case "pending":
    case "delivering":
      if (record.attempts === 0)
        return { text: record.status === "pending" ? "Waiting to send" : "Sending", tone: "info" };
      return {
        text: parts(
          record.status === "pending" ? "Retry pending" : "Retrying",
          attemptsText(record.attempts),
          responseText(last),
        ),
        tone: "warning",
      };
  }
}

/** Server → session stage. */
export function callbackDispatchLabel(
  record: SessionCallbackDispatchRecord | null,
): SessionCallbackLabel {
  if (record === null) return { text: "No server record", tone: "neutral" };
  switch (record.state) {
    case "queued":
      return {
        text:
          record.attempts === 0
            ? "Queued for the session"
            : `Queued · retrying after ${attemptsText(record.attempts)}`,
        tone: "info",
      };
    case "dispatching":
      return { text: "Posting to the session", tone: "info" };
    case "delivered":
      return { text: "Posted to the session", tone: "success" };
    case "terminal":
      return {
        text: `Stopped · ${sessionCallbackReason(record.terminalReason)}`,
        tone: deliberateStops.has(record.terminalReason ?? "") ? "neutral" : "error",
      };
  }
}

/** Not finished and not failed: a later refresh can still change it. */
export function sessionCallbackInProgress(event: SessionCallbackEvent): boolean {
  if (event.resolved || event.needsAttention) return false;
  if (event.dispatch)
    return event.dispatch.state === "queued" || event.dispatch.state === "dispatching";
  return event.transport?.status === "pending" || event.transport?.status === "delivering";
}

/**
 * Shown expanded on every surface: failures and work a refresh can still change. Everything
 * else, including events whose Toolyard stage is unknown, is collapsed history.
 */
export function sessionCallbackOpen(event: SessionCallbackEvent): boolean {
  return event.needsAttention || sessionCallbackInProgress(event);
}

const latestTime = (event: Omit<SessionCallbackEvent, "needsAttention" | "resolved">) => {
  const dispatched = event.dispatch ? Date.parse(event.dispatch.updatedAt) : Number.NaN;
  const attempted = event.transport ? (lastAttempt(event.transport)?.at ?? Number.NaN) : Number.NaN;
  const times = [dispatched, attempted].filter(Number.isFinite);
  // Unsent events have no timestamp yet; they are the newest work.
  return times.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...times);
};

/**
 * Joins Toolyard delivery records and this server's dispatch records by event ID, newest first.
 * Both server lists are bounded, so a missing side means "not in the returned window", not "never".
 */
export function sessionCallbackEvents(
  webhook: SessionWebhookView,
): ReadonlyArray<SessionCallbackEvent> {
  const transports = new Map(
    (webhook.deliveryHistory ?? []).map((record) => [record.eventId, record] as const),
  );
  const dispatches = new Map(webhook.deliveries.map((record) => [record.eventId, record] as const));
  const eventIds = new Set([...transports.keys(), ...dispatches.keys()]);
  return Array.from(eventIds, (eventId) => {
    const transport = transports.get(eventId) ?? null;
    const dispatch = dispatches.get(eventId) ?? null;
    const resolved = transport?.status === "delivered" && dispatch?.state === "delivered";
    // A posted notification does not erase an unresolved Toolyard transport failure.
    const transportStuck =
      transport !== null &&
      (transport.status === "failed" ||
        (transport.status !== "delivered" && transport.attempts > 0));
    const stopped =
      dispatch?.state === "terminal" && !deliberateStops.has(dispatch.terminalReason ?? "");
    const needsAttention = stopped || transportStuck;
    return { eventId, transport, dispatch, needsAttention, resolved };
  })
    .map((event, index) => ({ event, index, time: latestTime(event) }))
    .sort((left, right) => right.time - left.time || left.index - right.index)
    .map(({ event }) => event);
}
