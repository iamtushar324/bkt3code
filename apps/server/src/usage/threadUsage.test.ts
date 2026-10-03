// T3-CUSTOM(expbkt3): coverage for the per-thread usage fold.
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { aggregateThreadUsage } from "./threadUsage.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const rates: RateTable = new Map([
  [
    "claude-opus-5",
    {
      inputCostPerToken: 0.00001,
      outputCostPerToken: 0.00005,
      cacheReadCostPerToken: 0.000001,
      cacheCreationCostPerToken: 0.0000125,
      fast: null,
      ultrafast: null,
    },
  ],
]);

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    provider: "claude",
    timestampMs: Date.parse("2026-09-02T10:00:00.000Z"),
    model: "claude-opus-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 1000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...overrides,
  };
}

const pricing = { status: "fresh" as const, source: "test", fetchedAt: null, knownModels: 1 };
const threadId = ThreadId.make("thread-1");

describe("aggregateThreadUsage", () => {
  it("uses billed speed rates only for the selected thread's sessions", () => {
    const usage = aggregateThreadUsage({
      threadId,
      sessionIds: ["session-a"],
      records: [
        record({ provider: "codex", model: "gpt-codex", speed: "fast" }),
        record({ provider: "codex", model: "gpt-codex", speed: "ultrafast" }),
        record({
          provider: "codex",
          model: "gpt-codex",
          speed: "ultrafast",
          sessionId: "another-thread",
        }),
      ],
      rates: parseRateTable({
        "gpt-codex": {
          input_cost_per_token: 0.00001,
          output_cost_per_token: 0.00005,
          input_cost_per_token_priority: 0.00002,
          output_cost_per_token_priority: 0.0001,
          input_cost_per_token_ultrafast: 0.00003,
          output_cost_per_token_ultrafast: 0.00015,
        },
      }),
      timeZone: "UTC",
      readAt: "2026-09-03T12:00:00.000Z",
      pricing,
    });
    expect(usage.records).toBe(2);
    expect(usage.costUsd).toBeCloseTo(0.075, 6);
    expect(usage.models[0]?.costUsd).toBeCloseTo(0.075, 6);
    expect(usage.days[0]?.costUsd).toBeCloseTo(0.075, 6);
  });
  it("keeps only the thread's sessions and prices them per model and per day", () => {
    const usage = aggregateThreadUsage({
      threadId,
      sessionIds: ["session-a"],
      records: [
        record({}),
        record({ timestampMs: Date.parse("2026-09-03T10:00:00.000Z") }),
        record({ sessionId: "someone-else" }),
      ],
      rates,
      timeZone: "UTC",
      readAt: "2026-09-03T12:00:00.000Z",
      pricing,
    });
    expect(usage.records).toBe(2);
    // 1000 * 0.00001 + 100 * 0.00005 = 0.015 per record.
    expect(usage.costUsd).toBeCloseTo(0.03, 6);
    expect(usage.costSource).toBe("modelPriced");
    expect(usage.models).toHaveLength(1);
    expect(usage.models[0]?.model).toBe("claude-opus-5");
    expect(usage.days.map((day) => day.day)).toEqual(["2026-09-02", "2026-09-03"]);
    expect(usage.firstRecordAt).toBe("2026-09-02T10:00:00.000Z");
    expect(usage.lastRecordAt).toBe("2026-09-03T10:00:00.000Z");
  });

  it("drops duplicate records across files, as the usage page does", () => {
    const usage = aggregateThreadUsage({
      threadId,
      sessionIds: ["session-a"],
      records: [record({ dedupeKey: "m1" }), record({ dedupeKey: "m1" })],
      rates,
      timeZone: "UTC",
      readAt: "x",
      pricing,
    });
    expect(usage.records).toBe(1);
  });

  it("reports unpriced when no session is linked or no rate is known", () => {
    expect(
      aggregateThreadUsage({
        threadId,
        sessionIds: [],
        records: [record({})],
        rates,
        timeZone: "UTC",
        readAt: "x",
        pricing,
      }).costSource,
    ).toBe("unpriced");
    const unknownModel = aggregateThreadUsage({
      threadId,
      sessionIds: ["session-a"],
      records: [record({ model: "mystery" })],
      rates,
      timeZone: "UTC",
      readAt: "x",
      pricing,
    });
    expect(unknownModel.costSource).toBe("unpriced");
    expect(unknownModel.costUsd).toBe(0);
  });
});
