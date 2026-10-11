import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";

import { changeOf } from "./wait.ts";

// Only the event fields the classifier reads.
const stored = (event: Record<string, unknown>) =>
  ({
    sequence: 7,
    commandId: null,
    event: { threadId: "thread-1", ...event },
  }) as unknown as OrchestrationV2StoredEvent;

describe("changeOf", () => {
  it("reports a question or approval that opens, not the provider's own sign-in", () => {
    expect(
      changeOf(
        stored({
          type: "runtime-request.updated",
          payload: { status: "pending", kind: "user_input" },
        }),
      )?.change,
    ).toBe("needs-human");
    expect(
      changeOf(
        stored({
          type: "runtime-request.updated",
          payload: { status: "pending", kind: "command" },
        }),
      )?.what,
    ).toBe("asks to approve a command");
    expect(
      changeOf(
        stored({
          type: "runtime-request.updated",
          payload: { status: "pending", kind: "auth_refresh" },
        }),
      ),
    ).toBeNull();
    expect(
      changeOf(
        stored({
          type: "runtime-request.updated",
          payload: { status: "resolved", kind: "user_input" },
        }),
      ),
    ).toBeNull();
  });

  it("reports a run that ends or fails, not one that starts", () => {
    expect(
      changeOf(stored({ type: "run.updated", payload: { status: "completed" } }))?.change,
    ).toBe("finished");
    expect(changeOf(stored({ type: "run.updated", payload: { status: "failed" } }))?.change).toBe(
      "failed",
    );
    expect(changeOf(stored({ type: "run.updated", payload: { status: "running" } }))).toBeNull();
  });

  it("reports a question asked while the agent keeps working, in either input form", () => {
    expect(
      changeOf(
        stored({
          type: "turn-item.updated",
          payload: {
            type: "dynamic_tool",
            input: { forkLegacyActivity: { kind: "user-input.requested" } },
          },
        }),
      )?.change,
    ).toBe("needs-human");
    expect(
      changeOf(
        stored({
          type: "turn-item.updated",
          payload: {
            type: "dynamic_tool",
            input: '{"forkLegacyActivity":{"id":"a","kind":"user-input.requested", …',
          },
        }),
      )?.change,
    ).toBe("needs-human");
    expect(
      changeOf(stored({ type: "turn-item.updated", payload: { type: "assistant_message" } })),
    ).toBeNull();
  });
});
