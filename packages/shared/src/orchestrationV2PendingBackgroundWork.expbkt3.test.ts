// T3-CUSTOM(expbkt3): a command the provider wakes the agent after holds the
// session open, so the sidebar files it under Implementing, not Ready.
import { describe, expect, it } from "vite-plus/test";

import { backgroundWorkHoldsCompletion } from "./orchestrationV2PendingBackgroundWork.ts";

describe("backgroundWorkHoldsCompletion (expbkt3 wakesAgent)", () => {
  it("holds for a command that wakes the agent", () => {
    expect(backgroundWorkHoldsCompletion([{ kind: "command", wakesAgent: true }])).toBe(true);
  });

  it("does not hold for a command left running, such as a dev server", () => {
    expect(backgroundWorkHoldsCompletion([{ kind: "command" }])).toBe(false);
    expect(backgroundWorkHoldsCompletion([{ kind: "command", wakesAgent: false }])).toBe(false);
  });
});
