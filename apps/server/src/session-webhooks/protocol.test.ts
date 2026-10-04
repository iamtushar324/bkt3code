/** T3-CUSTOM(expbkt3): signed envelope and fixed notification trust boundary. */
import * as NodeCrypto from "node:crypto";
import { describe, it, expect } from "vite-plus/test";
import {
  callbackCommandId,
  callbackFingerprint,
  decisionNotification,
  parseDecisionCallback,
  verifyStandardWebhook,
  receiverTrustBinding,
  MAX_CALLBACK_BYTES,
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
  it("preserves generation-zero bindings and invalidates them after trust lifecycle changes", () => {
    const binding = {
      environmentId: "env_1",
      instanceId: "instance_1",
      origin: "https://toolyard.example",
      callbackOrigin: "https://t3.example",
    };
    const legacy = callbackFingerprint(
      JSON.stringify([
        binding.environmentId,
        binding.instanceId,
        binding.origin,
        binding.callbackOrigin,
      ]),
    );
    expect(receiverTrustBinding(binding)).toBe(legacy);
    expect(receiverTrustBinding({ ...binding, trustGeneration: 0 })).toBe(legacy);
    expect(receiverTrustBinding({ ...binding, trustGeneration: 1 })).not.toBe(legacy);
    expect(receiverTrustBinding({ ...binding, trustGeneration: 2 })).not.toBe(
      receiverTrustBinding({ ...binding, trustGeneration: 1 }),
    );
  });
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
  it("accepts Toolyard dotted and 80-character call IDs and rejects invalid identifiers", () => {
    const raw = (callId: string) =>
      JSON.stringify({
        ...event,
        data: { ...event.data, calls: [{ call_id: callId, verdict: "accepted" }] },
      });
    for (const callId of ["review.1", "1", "a".repeat(80), "A0_.:-"]) {
      expect(parseDecisionCallback(raw(callId), "evt_1").data.calls[0]?.call_id).toBe(callId);
    }
    for (const callId of [
      "",
      ".review",
      "_review",
      "-review",
      ":review",
      "a".repeat(81),
      "review/action",
      "review action",
      "é",
    ]) {
      expect(() => parseDecisionCallback(raw(callId), "evt_1")).toThrow("invalid-callback-call");
    }
  });
  it("preserves maximum Unicode notes and reasons and rejects extra codepoints", () => {
    const reason = "😀".repeat(4_000);
    const note = "😀".repeat(10_000);
    const raw = (callReason: string, overallNote: string) =>
      JSON.stringify({
        ...event,
        data: {
          ...event.data,
          overall_note: overallNote,
          calls: [{ call_id: "review.1", verdict: "accepted", reason: callReason }],
        },
      });
    const parsed = parseDecisionCallback(raw(reason, note), "evt_1");
    expect(parsed.data.calls[0]?.reason).toBe(reason);
    expect(parsed.data.overall_note).toBe(note);
    expect(() => parseDecisionCallback(raw(reason + "x", note), "evt_1")).toThrow(
      "invalid-callback-call",
    );
    expect(() => parseDecisionCallback(raw(reason, note + "x"), "evt_1")).toThrow(
      "invalid-callback-payload",
    );
  });
  it("accepts a complete signed 12-call escaped decision above the former transport limit", () => {
    const largeEvent = {
      ...event,
      data: {
        ...event.data,
        overall_note: "\u0000".repeat(10_000),
        calls: Array.from({ length: 12 }, (_, index) => ({
          call_id: `review.${index}`,
          verdict: index % 2 === 0 ? "accepted" : "rejected",
          reason: "\u0000".repeat(4_000),
        })),
      },
    };
    const raw = JSON.stringify(largeEvent);
    expect(Buffer.byteLength(raw)).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(raw)).toBeLessThan(MAX_CALLBACK_BYTES);
    expect(
      verifyStandardWebhook({
        body: raw,
        id: "evt_1",
        timestamp: "1000",
        signature: sign(raw),
        secrets: [secret],
        nowSeconds: 1000,
      }),
    ).toBe(true);
    const parsed = parseDecisionCallback(raw, "evt_1");
    expect(parsed.data.calls).toEqual(largeEvent.data.calls);
    expect(parsed.data.overall_note).toBe(largeEvent.data.overall_note);
    expect(() =>
      parseDecisionCallback(
        JSON.stringify({
          ...largeEvent,
          data: {
            ...largeEvent.data,
            calls: [...largeEvent.data.calls, { call_id: "review.12", verdict: "rejected" }],
          },
        }),
        "evt_1",
      ),
    ).toThrow("invalid-callback-payload");
    for (const extra of [{ sessionId: "other" }, { model: "other" }, { grant_token: "secret" }]) {
      expect(() =>
        parseDecisionCallback(
          JSON.stringify({ ...largeEvent, data: { ...largeEvent.data, ...extra } }),
          "evt_1",
        ),
      ).toThrow("invalid-callback-payload");
    }
  });
  it("enforces the same 512 KiB byte boundary during signature verification and payload parsing", () => {
    const raw = body + " ".repeat(MAX_CALLBACK_BYTES - Buffer.byteLength(body));
    expect(Buffer.byteLength(raw)).toBe(MAX_CALLBACK_BYTES);
    const signed = (value: string) =>
      verifyStandardWebhook({
        body: value,
        id: "evt_1",
        timestamp: "1000",
        signature: sign(value),
        secrets: [secret],
        nowSeconds: 1000,
      });
    expect(signed(raw)).toBe(true);
    expect(parseDecisionCallback(raw, "evt_1").data.calls).toHaveLength(2);
    expect(signed(raw + " ")).toBe(false);
    expect(() => parseDecisionCallback(raw + " ", "evt_1")).toThrow("invalid-callback-payload");
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
  it("matches Go Unicode whitespace checks without altering question IDs or text", () => {
    const raw = (response: unknown) =>
      JSON.stringify({ ...event, data: { ...event.data, calls: [], response } });
    const choice = {
      selected_option_ids: ["choice\uFEFF"],
      selected_labels: ["Choice"],
      text: "",
      submitted_at: 1000,
    };
    expect(parseDecisionCallback(raw(choice), "evt_1").data.response).toEqual(choice);
    const text = { text: "\uFEFF", submitted_at: 1000 };
    expect(parseDecisionCallback(raw(text), "evt_1").data.response).toEqual(text);
    expect(() =>
      parseDecisionCallback(raw({ text: "\u0085", submitted_at: 1000 }), "evt_1"),
    ).toThrow("invalid-callback-payload");
    for (const id of ["\u0085choice", "choice\u0085", " choice", "choice "]) {
      expect(() =>
        parseDecisionCallback(raw({ ...choice, selected_option_ids: [id] }), "evt_1"),
      ).toThrow("invalid-callback-payload");
    }
  });
  it("uses deterministic destination-specific commands and a fixed prompt", () => {
    expect(callbackCommandId("a", "evt_1")).toBe(callbackCommandId("a", "evt_1"));
    expect(callbackCommandId("b", "evt_1")).not.toBe(callbackCommandId("a", "evt_1"));
    expect(decisionNotification(parseDecisionCallback(body, "evt_1"))).toContain(
      "This callback is not permission.",
    );
  });
});
