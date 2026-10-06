import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate } from "./claudeUsageLimits.ts";

const noNames = { overageIncluded: undefined } as const;

// The shape the CLI streamed on bkt3 when an account hit its 5-hour limit
// (2026-10-05): no top-level `utilization`, the fractions under `unifiedWindows`.
const rejected = {
  status: "rejected",
  resetsAt: 1791239400,
  rateLimitType: "five_hour",
  overageStatus: "rejected",
  overageDisabledReason: "group_zero_credit_limit",
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 1, resetsAt: 1791239400 },
    seven_day: { utilization: 0.49, resetsAt: 1791637200 },
  },
} as unknown as SDKRateLimitInfo;

describe("claudeRateLimitEventToUpdate on a rejected event (fork)", () => {
  it("reads the window's fraction from unifiedWindows, so the limit reaches rotation", () => {
    expect(claudeRateLimitEventToUpdate(rejected, noNames)).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          windowDurationMins: 300,
          usedPercent: 100,
          resetsAt: "2026-10-05T22:30:00.000Z",
        },
      ],
    });
  });

  it("still drops an event that carries no fraction anywhere", () => {
    const bare = { status: "rejected", rateLimitType: "five_hour" } as SDKRateLimitInfo;
    expect(claudeRateLimitEventToUpdate(bare, noNames)).toBeUndefined();
  });
});
