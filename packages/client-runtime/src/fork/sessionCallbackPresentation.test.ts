/** T3-CUSTOM(expbkt3): callback stages stay separate, failures stay visible, history stays honest. */
import { describe, expect, it } from "vite-plus/test";
import { ThreadId, type SessionWebhookView } from "@t3tools/contracts";
import {
  callbackDispatchLabel,
  callbackTransportLabel,
  sessionCallbackEvents,
  sessionCallbackHistoryWarning,
  sessionCallbackAttentionCount,
  sessionCallbackInProgress,
  sessionCallbackOpen,
  sessionCallbackReason,
  sessionCallbackSessionName,
  sessionWebhookChangeConfirmation,
  sessionWebhookChangeFailureMessage,
  sessionWebhookLifecycleNotice,
  sessionWebhookRemovedIssues,
  type SessionCallbackDispatchRecord,
  type SessionCallbackTransportRecord,
} from "./sessionCallbackPresentation.ts";

const webhook = (overrides: Partial<SessionWebhookView> = {}): SessionWebhookView => ({
  id: "swh_00000000000000000000000000000001",
  threadId: ThreadId.make("fa43d915-1111-2222-3333-444455556666"),
  instanceId: "instance-1",
  callbackRef: "cb_1",
  status: "active",
  revision: 3,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  terminalReason: null,
  deliveries: [],
  deliveryHistory: [],
  deliveryHistoryError: null,
  ...overrides,
});
const receivedAt = Date.parse("2026-10-01T10:01:00.000Z");
const transport = (
  eventId: string,
  overrides: Partial<SessionCallbackTransportRecord> = {},
): SessionCallbackTransportRecord => ({
  eventId,
  inboxId: `inbox-${eventId}`,
  status: "delivered",
  attempts: 1,
  terminalReason: null,
  history: [{ attempt: 1, at: receivedAt, httpStatus: 202, outcome: "ok" }],
  ...overrides,
});
const dispatch = (
  eventId: string,
  overrides: Partial<SessionCallbackDispatchRecord> = {},
): SessionCallbackDispatchRecord => ({
  eventId,
  state: "delivered",
  attempts: 1,
  receivedAt: "2026-10-01T10:01:00.000Z",
  updatedAt: "2026-10-01T10:01:01.000Z",
  terminalReason: null,
  ...overrides,
});

describe("session callback presentation", () => {
  it("keeps a received callback that stopped before the session visibly incomplete", () => {
    const [event] = sessionCallbackEvents(
      webhook({
        deliveryHistory: [transport("evt_1")],
        deliveries: [
          dispatch("evt_1", {
            state: "terminal",
            terminalReason: "destination-paused-or-archived",
          }),
        ],
      }),
    );
    expect(event).toMatchObject({ eventId: "evt_1", needsAttention: true, resolved: false });
    expect(callbackTransportLabel(event!.transport)).toEqual({
      text: "Received · HTTP 202",
      tone: "success",
    });
    expect(callbackDispatchLabel(event!.dispatch)).toEqual({
      text: "Stopped · Session paused, snoozed, archived or stopped",
      tone: "error",
    });
  });

  it("keeps a network-error retry visible while another event succeeds", () => {
    const events = sessionCallbackEvents(
      webhook({
        deliveryHistory: [
          transport("evt_retry", {
            status: "pending",
            attempts: 6,
            history: Array.from({ length: 6 }, (_, index) => ({
              attempt: 6 - index,
              at: Date.parse("2026-10-01T09:00:00.000Z") + (6 - index) * 1000,
              httpStatus: null,
              outcome: "network_error",
            })),
          }),
          transport("evt_ok"),
        ],
        deliveries: [dispatch("evt_ok")],
      }),
    );
    const retry = events.find((event) => event.eventId === "evt_retry")!;
    const ok = events.find((event) => event.eventId === "evt_ok")!;
    expect(retry).toMatchObject({ needsAttention: true, resolved: false, dispatch: null });
    expect(callbackTransportLabel(retry.transport).text).toBe(
      "Retry pending · 6 attempts · No HTTP response",
    );
    expect(callbackDispatchLabel(retry.dispatch).text).toBe("No server record");
    expect(ok).toMatchObject({ needsAttention: false, resolved: true });
    expect(sessionCallbackReason("network_error")).toBe("No HTTP response (network error)");
  });

  it("keeps a Toolyard retry visible beside the queued session notification", () => {
    const [event] = sessionCallbackEvents(
      webhook({
        deliveryHistory: [transport("evt_1", { status: "pending", attempts: 2 })],
        deliveries: [dispatch("evt_1", { state: "queued", attempts: 0 })],
      }),
    );
    expect(event).toMatchObject({ needsAttention: true, resolved: false });
    expect(sessionCallbackInProgress(event!)).toBe(false);
  });

  it("joins partial history without dropping either side and labels the gap honestly", () => {
    const events = sessionCallbackEvents(
      webhook({
        deliveryHistory: [transport("evt_toolyard_only", { status: "failed", attempts: 8 })],
        deliveries: [dispatch("evt_server_only", { state: "queued", attempts: 0 })],
      }),
    );
    expect(events.map((event) => event.eventId).toSorted()).toEqual([
      "evt_server_only",
      "evt_toolyard_only",
    ]);
    const serverOnly = events.find((event) => event.eventId === "evt_server_only")!;
    expect(serverOnly.transport).toBeNull();
    expect(callbackTransportLabel(serverOnly.transport).text).toBe("No Toolyard delivery record");
    const toolyardOnly = events.find((event) => event.eventId === "evt_toolyard_only");
    expect(toolyardOnly?.needsAttention).toBe(true);
  });

  it("keeps server records and warns when Toolyard history is unavailable", () => {
    const unavailable = webhook({
      deliveryHistory: [],
      deliveryHistoryError: "delivery-history-unavailable",
      deliveries: [
        dispatch("evt_1", { state: "terminal", terminalReason: "dispatch-retry-limit" }),
      ],
    });
    expect(sessionCallbackHistoryWarning(unavailable)).toContain("unavailable");
    const [event] = sessionCallbackEvents(unavailable);
    expect(event).toMatchObject({ eventId: "evt_1", needsAttention: true, transport: null });
    expect(callbackTransportLabel(event!.transport, false).text).toBe(
      "Toolyard history unavailable",
    );
    expect(sessionCallbackHistoryWarning(webhook())).toBeNull();
    expect(sessionCallbackHistoryWarning(webhook({ deliveryHistory: undefined }))).toContain(
      "did not return",
    );
  });

  it("returns unknown reason codes verbatim and never reflects unknown change failures", () => {
    expect(sessionCallbackReason("future_reason_v2")).toBe("future_reason_v2");
    expect(sessionCallbackReason("constructor")).toBe("constructor");
    expect(sessionCallbackReason(null)).toBe("No reason recorded");
    const unknownStop = dispatch("e", { state: "terminal", terminalReason: "x_y" });
    expect(callbackDispatchLabel(unknownStop).text).toBe("Stopped · x_y");
    expect(sessionWebhookChangeFailureMessage("webhook-revision-conflict")).toContain("Refresh");
    for (const unknown of ["secret token abc", "toString", null])
      expect(sessionWebhookChangeFailureMessage(unknown)).toBe(
        "The change did not apply. Refresh the callback status before another attempt.",
      );
  });

  it("keeps a failed transport visible even when the session received the notification", () => {
    const [event] = sessionCallbackEvents(
      webhook({
        deliveryHistory: [transport("evt_1", { status: "failed", terminalReason: "retry_limit" })],
        deliveries: [dispatch("evt_1")],
      }),
    );
    expect(event).toMatchObject({ resolved: false, needsAttention: true });
    expect(callbackTransportLabel(event!.transport)).toMatchObject({ tone: "error" });
    expect(callbackTransportLabel(event!.transport).text).toContain(
      "Stopped after Toolyard's retry limit",
    );
  });

  it("orders events newest first and puts unsent events on top", () => {
    const events = sessionCallbackEvents(
      webhook({
        deliveryHistory: [transport("evt_unsent", { status: "pending", attempts: 0, history: [] })],
        deliveries: [
          dispatch("evt_old", { updatedAt: "2026-10-01T08:00:00.000Z" }),
          dispatch("evt_new", { updatedAt: "2026-10-01T12:00:00.000Z" }),
        ],
      }),
    );
    expect(events.map((event) => event.eventId)).toEqual(["evt_unsent", "evt_new", "evt_old"]);
    expect(events[0]).toMatchObject({ needsAttention: false, resolved: false });
    expect(sessionCallbackInProgress(events[0]!)).toBe(true);
  });

  it("uses the authorized title or an honest short-ID fallback", () => {
    expect(sessionCallbackSessionName("fa43d915-aaaa", "  Fix login  ")).toEqual({
      text: "Fix login",
      fallback: false,
    });
    expect(sessionCallbackSessionName("fa43d915-aaaa", null)).toEqual({
      text: "Session fa43d915…",
      fallback: true,
    });
    expect(sessionCallbackSessionName("fa43d915-aaaa", " ").fallback).toBe(true);
  });

  it("keeps deliberate Disable and Remove stops as history, not failures", () => {
    for (const reason of ["disable", "remove"]) {
      const events = sessionCallbackEvents(
        webhook({
          status: reason === "disable" ? "disabled" : "removed",
          terminalReason: reason,
          deliveryHistory: [transport("evt_stopped")],
          deliveries: [dispatch("evt_stopped", { state: "terminal", terminalReason: reason })],
        }),
      );
      expect(events[0]).toMatchObject({ needsAttention: false, resolved: false });
      expect(sessionCallbackOpen(events[0]!)).toBe(false);
      expect(sessionCallbackAttentionCount(events)).toBe(0);
      expect(callbackDispatchLabel(events[0]!.dispatch)).toEqual({
        text: `Stopped · Webhook ${reason === "disable" ? "disabled" : "removed"}`,
        tone: "neutral",
      });
    }
    // A failure on the same webhook still counts.
    const mixed = sessionCallbackEvents(
      webhook({
        status: "disabled",
        terminalReason: "disable",
        deliveries: [
          dispatch("evt_stopped", { state: "terminal", terminalReason: "disable" }),
          dispatch("evt_failed", { state: "terminal", terminalReason: "dispatch-retry-limit" }),
        ],
      }),
    );
    expect(sessionCallbackAttentionCount(mixed)).toBe(1);
    expect(mixed.filter(sessionCallbackOpen).map((event) => event.eventId)).toEqual(["evt_failed"]);
  });

  it("collapses unknown history without calling it resolved, and keeps failures open", () => {
    const events = sessionCallbackEvents(
      webhook({
        deliveryHistory: [],
        deliveryHistoryError: "delivery-history-unavailable",
        deliveries: [
          dispatch("evt_posted"),
          dispatch("evt_queued", { state: "queued", attempts: 0 }),
          dispatch("evt_failed", { state: "terminal", terminalReason: "destination-busy" }),
        ],
      }),
    );
    const byId = (id: string) => events.find((event) => event.eventId === id)!;
    expect(byId("evt_posted")).toMatchObject({ resolved: false, needsAttention: false });
    expect(sessionCallbackOpen(byId("evt_posted"))).toBe(false);
    expect(callbackTransportLabel(byId("evt_posted").transport, false).text).toBe(
      "Toolyard history unavailable",
    );
    expect(sessionCallbackOpen(byId("evt_queued"))).toBe(true);
    expect(sessionCallbackOpen(byId("evt_failed"))).toBe(true);
  });

  it("reports pending syncs as info and stopped syncs as errors without a retry promise", () => {
    for (const code of [
      "secret-rotation-pending",
      "rotate-server-sync-pending",
      "disable-server-sync-pending",
      "remove-server-sync-pending",
    ])
      expect(sessionWebhookLifecycleNotice(webhook({ terminalReason: code }))?.tone).toBe("info");
    for (const code of [
      "rotate-server-sync-failed",
      "disable-server-sync-failed",
      "remove-server-sync-failed",
    ]) {
      const notice = sessionWebhookLifecycleNotice(webhook({ terminalReason: code }))!;
      expect(notice.tone).toBe("error");
      expect(notice.text).toContain("stopped retrying");
      expect(notice.text).not.toMatch(/keeps retrying|server retries/);
      expect(sessionCallbackReason(code)).toContain("stopped retrying");
    }
    expect(sessionWebhookLifecycleNotice(webhook())).toBeNull();
    expect(sessionWebhookLifecycleNotice(webhook({ terminalReason: "disable" }))).toBeNull();
    expect(sessionWebhookLifecycleNotice(webhook({ terminalReason: "remove" }))).toBeNull();
    expect(sessionWebhookLifecycleNotice(webhook({ terminalReason: "future_v2" }))).toEqual({
      text: "future_v2",
      tone: "neutral",
    });
    // A blocked change cannot promise a retry the server may have stopped.
    const blocked = sessionWebhookChangeFailureMessage("webhook-server-sync-pending");
    expect(blocked).not.toMatch(/server retries|try again shortly/);
    expect(blocked).toContain("Refresh");
  });

  it("collects removed-webhook issues that must stay outside the collapsed section", () => {
    const removed = webhook({
      status: "removed",
      terminalReason: "remove-server-sync-failed",
      deliveryHistory: undefined,
      deliveries: [
        dispatch("evt_failed", { state: "terminal", terminalReason: "dispatch-rejected" }),
        dispatch("evt_stopped", { state: "terminal", terminalReason: "remove" }),
      ],
    });
    const issues = sessionWebhookRemovedIssues(removed, sessionCallbackEvents(removed));
    expect(issues.map((issue) => issue.tone)).toEqual(["error", "warning", "warning"]);
    expect(issues[2]!.text).toBe("Its history has 1 failed or stopped event.");
    const quiet = webhook({ status: "removed", terminalReason: "remove" });
    expect(sessionWebhookRemovedIssues(quiet, sessionCallbackEvents(quiet))).toEqual([]);
  });

  it("shares confirmation copy that names the session and the bounded sync retry", () => {
    const rotate = sessionWebhookChangeConfirmation("rotate", "Fix login");
    expect(rotate.title).toBe("Rotate the secret for Fix login?");
    expect(rotate.description).toContain("previous secret keeps working for five minutes");
    for (const action of ["rotate", "disable", "remove"] as const)
      expect(sessionWebhookChangeConfirmation(action, "S").description).toContain(
        "for a limited time",
      );
    expect(sessionWebhookChangeConfirmation("remove", "S").confirm).toBe("Remove");
  });
});
