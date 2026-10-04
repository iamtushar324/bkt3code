/** T3-CUSTOM(expbkt3): Callback history is bounded, typed, and excludes credentials/results. */
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ToolyardCallbackInspection } from "./ToolyardIntegration.ts";

const decodeHistory = Schema.decodeUnknownEffect(ToolyardCallbackInspection);
const decision = {
  event_id: "decision-one",
  inbox_id: "inbox-one",
  status: "failed",
  attempts: 1,
  terminal_reason: "receiver_unavailable",
  history: [{ attempt: 1, at: 1_790_000_000_000, http_status: 503, outcome: "http_error" }],
};
it.effect(
  "keeps physical delivery history but excludes receiver secrets and sensitive results",
  () =>
    Effect.gen(function* () {
      const result = yield* decodeHistory({
        receiver: { secret: "signing-secret", token: "agent-token" },
        deliveries: [
          {
            ...decision,
            credentials: "agent-secret",
            results: { private: "sensitive result" },
            history: [{ ...decision.history[0], grant_token: "permission-token" }],
          },
        ],
      });
      expect(result).toEqual({ deliveries: [decision] });
    }),
);
it.effect("rejects malformed or excessive delivery history", () =>
  Effect.gen(function* () {
    for (const input of [
      { deliveries: [{ ...decision, attempts: -1 }] },
      { deliveries: [{ ...decision, history: [{ ...decision.history[0], http_status: 700 }] }] },
      {
        deliveries: [
          { ...decision, history: Array.from({ length: 257 }, () => decision.history[0]) },
        ],
      },
      { deliveries: Array.from({ length: 101 }, () => decision) },
    ])
      expect((yield* Effect.result(decodeHistory(input)))._tag).toBe("Failure");
  }),
);
