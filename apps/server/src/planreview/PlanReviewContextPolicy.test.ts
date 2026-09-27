import { describe, expect, it } from "vite-plus/test";

import { decidePlanResend } from "./PlanReviewContextPolicy.ts";

const baseSignals = {
  latestCompactionAt: null,
  planCreatedAt: "2026-08-07T10:00:00.000Z",
  planThreadId: "thread-1",
  targetThreadId: "thread-1",
  providerSessionStatus: "running",
} as const;

describe("decidePlanResend", () => {
  it("keeps the prompt short when the model can still see the plan", () => {
    expect(decidePlanResend(baseSignals)).toEqual({ shouldResend: false, reason: null });
  });

  it("resends when implementation moves to another thread", () => {
    const decision = decidePlanResend({ ...baseSignals, targetThreadId: "thread-2" });
    expect(decision.shouldResend).toBe(true);
    expect(decision.reason).toContain("different session");
  });

  it("resends when the thread compacted after the plan was written", () => {
    const decision = decidePlanResend({
      ...baseSignals,
      latestCompactionAt: "2026-08-07T11:00:00.000Z",
    });
    expect(decision.shouldResend).toBe(true);
    expect(decision.reason).toContain("compacted");
  });

  it("ignores a compaction that happened before the plan", () => {
    expect(
      decidePlanResend({ ...baseSignals, latestCompactionAt: "2026-08-07T09:00:00.000Z" })
        .shouldResend,
    ).toBe(false);
  });

  it("resends when no provider session is bound", () => {
    expect(decidePlanResend({ ...baseSignals, providerSessionStatus: null }).shouldResend).toBe(
      true,
    );
  });

  it("resends when the provider session has stopped", () => {
    const decision = decidePlanResend({ ...baseSignals, providerSessionStatus: "stopped" });
    expect(decision.shouldResend).toBe(true);
    expect(decision.reason).toContain("no longer running");
  });

  it("prefers the cross-thread reason when several signals fire at once", () => {
    const decision = decidePlanResend({
      ...baseSignals,
      targetThreadId: "thread-2",
      providerSessionStatus: null,
      latestCompactionAt: "2026-08-07T23:00:00.000Z",
    });
    expect(decision.reason).toContain("different session");
  });
});
