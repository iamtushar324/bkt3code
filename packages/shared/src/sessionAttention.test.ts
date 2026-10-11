import { describe, expect, it } from "vite-plus/test";

import { classifySessionAttention, type SessionAttentionInput } from "./sessionAttention.ts";

const idle: SessionAttentionInput = {
  pendingRequestKind: null,
  hasPendingAsyncUserInput: false,
  hasActionableProposedPlan: false,
  agentActive: false,
  failed: false,
};

describe("classifySessionAttention", () => {
  it("reports nothing for an idle session with nothing open", () => {
    expect(classifySessionAttention(idle)).toBeNull();
  });

  it("ranks a blocking question above everything else", () => {
    expect(
      classifySessionAttention({
        ...idle,
        pendingRequestKind: "user_input",
        hasPendingAsyncUserInput: true,
        hasActionableProposedPlan: true,
        failed: true,
      }),
    ).toBe("question");
  });

  it("counts provider approvals but not the provider's own sign-in", () => {
    expect(classifySessionAttention({ ...idle, pendingRequestKind: "command" })).toBe("approval");
    expect(classifySessionAttention({ ...idle, pendingRequestKind: "auth_refresh" })).toBeNull();
  });

  it("keeps an async question while the agent works", () => {
    expect(
      classifySessionAttention({ ...idle, hasPendingAsyncUserInput: true, agentActive: true }),
    ).toBe("async-question");
  });

  it("waits for the agent to stop before a plan or a failure counts", () => {
    expect(
      classifySessionAttention({ ...idle, hasActionableProposedPlan: true, agentActive: true }),
    ).toBeNull();
    expect(classifySessionAttention({ ...idle, hasActionableProposedPlan: true })).toBe("plan");
    expect(classifySessionAttention({ ...idle, failed: true, agentActive: true })).toBeNull();
    expect(
      classifySessionAttention({ ...idle, failed: true, hasActionableProposedPlan: true }),
    ).toBe("failed");
  });
});
