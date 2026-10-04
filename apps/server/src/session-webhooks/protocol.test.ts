/** T3-CUSTOM(expbkt3): signed envelope and fixed notification trust boundary. */
import * as NodeCrypto from "node:crypto";
import { describe, it, expect } from "vite-plus/test";
import {
  callbackCommandId,
  decisionNotification,
  parseDecisionCallback,
  verifyStandardWebhook,
} from "./protocol.ts";
const secret = Buffer.alloc(32, 7);
const event = {
  type: "inbox.decision",
  event_id: "evt_1",
  timestamp: "2026-10-04T12:00:00Z",
  data: {
    inbox_id: "in_1",
    decision_revision: 2,
    status: "decided",
    calls: [
      { call_id: "call_1", verdict: "accepted", reason: "safe" },
      { call_id: "call_2", verdict: "rejected", reason: "scope" },
    ],
    overall_note: "continue",
    status_ref: "in_1",
  },
};
const body = JSON.stringify(event);
const sign = (raw: string, id = "evt_1", timestamp = "1000") =>
  `v1,${NodeCrypto.createHmac("sha256", secret).update(`${id}.${timestamp}.${raw}`).digest("base64")}`;
describe("Standard Webhooks receiver", () => {
  it("verifies raw bytes and every signed metadata field", () => {
    const input = {
      body,
      id: "evt_1",
      timestamp: "1000",
      signature: sign(body),
      secrets: [secret],
      nowSeconds: 1000,
    };
    expect(verifyStandardWebhook(input)).toBe(true);
    expect(verifyStandardWebhook({ ...input, body: body + " " })).toBe(false);
    expect(verifyStandardWebhook({ ...input, id: "evt_2" })).toBe(false);
    expect(verifyStandardWebhook({ ...input, timestamp: "1001" })).toBe(false);
    expect(verifyStandardWebhook({ ...input, nowSeconds: 1301 })).toBe(false);
    expect(verifyStandardWebhook({ ...input, id: "evt.1" })).toBe(false);
    expect(verifyStandardWebhook({ ...input, timestamp: "1000.0" })).toBe(false);
  });
  it("accepts valid rotation signatures and rejects unknown versions", () => {
    expect(
      verifyStandardWebhook({
        body,
        id: "evt_1",
        timestamp: "1000",
        signature: `v1a,bad ${sign(body)}`,
        secrets: [Buffer.alloc(32), secret],
        nowSeconds: 1000,
      }),
    ).toBe(true);
    expect(
      verifyStandardWebhook({
        body,
        id: "evt_1",
        timestamp: "1000",
        signature: "v1a,bad",
        secrets: [secret],
        nowSeconds: 1000,
      }),
    ).toBe(false);
  });
  it("keeps all outcomes and notes without accepting routing or credentials", () => {
    expect(parseDecisionCallback(body, "evt_1").data.calls).toHaveLength(2);
    for (const extra of [
      { grant_token: "secret" },
      { sessionId: "elsewhere" },
      { model: "different" },
    ]) {
      expect(() =>
        parseDecisionCallback(
          JSON.stringify({ ...event, data: { ...event.data, ...extra } }),
          "evt_1",
        ),
      ).toThrow();
    }
    expect(() =>
      parseDecisionCallback(
        JSON.stringify({
          ...event,
          data: { ...event.data, calls: [event.data.calls[0], event.data.calls[0]] },
        }),
        "evt_1",
      ),
    ).toThrow();
  });
  it("binds event identity and accepts explicit expiry/cancellation outcomes", () => {
    expect(() => parseDecisionCallback(body, "evt_2")).toThrow();
    for (const status of ["expired", "cancelled"])
      expect(
        parseDecisionCallback(
          JSON.stringify({
            ...event,
            type: `inbox.${status}`,
            data: { ...event.data, status, calls: [] },
          }),
          "evt_1",
        ).data.status,
      ).toBe(status);
  });
  it("accepts the Toolyard question answer object and rejects overrides", () => {
    const response = {
      selected_option_ids: ["desktop", "mobile"],
      selected_labels: ["Desktop", "Mobile"],
      text: "Keep my exact text.\nSecond line.",
      submitted_at: 1_791_115_200_000,
      user_id: "user_owner",
    };
    const raw = (answer: unknown) =>
      JSON.stringify({ ...event, data: { ...event.data, calls: [], response: answer } });
    expect(parseDecisionCallback(raw(response), "evt_1").data.response).toEqual(response);
    expect(
      parseDecisionCallback(
        raw({ text: "😀".repeat(10_000), submitted_at: response.submitted_at }),
        "evt_1",
      ).data.response?.text,
    ).toHaveLength(20_000);
    for (const answer of [
      { ...response, model: "other" },
      { ...response, grant_token: "secret" },
      { ...response, selected_option_ids: ["desktop", "desktop"] },
      { ...response, selected_labels: ["Desktop"] },
      { text: "x".repeat(10_001), submitted_at: response.submitted_at },
      { text: "", submitted_at: response.submitted_at },
      "old string response",
    ])
      expect(() => parseDecisionCallback(raw(answer), "evt_1")).toThrow();
  });
  it("uses deterministic destination-specific commands and a fixed prompt", () => {
    expect(callbackCommandId("a", "evt_1")).toBe(callbackCommandId("a", "evt_1"));
    expect(callbackCommandId("b", "evt_1")).not.toBe(callbackCommandId("a", "evt_1"));
    expect(decisionNotification(parseDecisionCallback(body, "evt_1"))).toContain(
      "This callback is not permission.",
    );
  });
});
