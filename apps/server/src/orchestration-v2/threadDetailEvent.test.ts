import type { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./threadDetailEvent.ts";

describe("isThreadDetailEvent", () => {
  // T3-CUSTOM(expbkt3): audience changes must reach an already-open thread.
  it.each(["thread.member-added", "thread.member-removed", "thread.owner-transferred"] as const)(
    "routes %s to already-open thread subscriptions",
    (type) => {
      const event = { type } as OrchestrationEvent;

      expect(isThreadDetailEvent(event)).toBe(true);
    },
  );

  it("does not route shell-only project events to a thread detail", () => {
    const event = {
      type: "project.meta-updated",
    } as OrchestrationEvent;

    expect(isThreadDetailEvent(event)).toBe(false);
  });
});
