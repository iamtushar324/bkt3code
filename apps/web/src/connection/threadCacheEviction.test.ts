import { describe, expect, it } from "@effect/vitest";

import {
  DEFAULT_THREAD_CACHE_PROTECTED_WINDOW_MS,
  cachedParentRefOf,
  selectThreadCacheEvictions,
  threadCacheKey,
  type ThreadCacheMetaRecord,
} from "./threadCacheEviction";

const NOW = 1_800_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function record(overrides: Partial<ThreadCacheMetaRecord> = {}): ThreadCacheMetaRecord {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    // Old enough that nothing is protected merely for being recent.
    lastOpenedAtEpochMs: NOW - 30 * DAY_MS,
    pinnedUntilEpochMs: null,
    sizeChars: 1_000,
    ...overrides,
  };
}

describe("selectThreadCacheEvictions", () => {
  it("keeps everything when the cache fits its budget", () => {
    const plan = selectThreadCacheEvictions([record(), record({ threadId: "thread-2" })], {
      nowEpochMs: NOW,
      totalBudgetChars: 10_000,
    });

    expect(plan.evictKeys).toEqual([]);
    expect(plan.retainedChars).toBe(2_000);
    expect(plan.overBudget).toBe(false);
  });

  it("evicts least-recently-opened first until it fits", () => {
    const plan = selectThreadCacheEvictions(
      [
        record({ threadId: "oldest", lastOpenedAtEpochMs: NOW - 90 * DAY_MS }),
        record({ threadId: "middle", lastOpenedAtEpochMs: NOW - 60 * DAY_MS }),
        record({ threadId: "newest", lastOpenedAtEpochMs: NOW - 30 * DAY_MS }),
      ],
      { nowEpochMs: NOW, totalBudgetChars: 2_000 },
    );

    expect(plan.evictKeys).toEqual([threadCacheKey("env-1", "oldest")]);
    expect(plan.retainedChars).toBe(2_000);
    expect(plan.overBudget).toBe(false);
  });

  it("drops a thread that exceeds the per-thread cap on its own", () => {
    const plan = selectThreadCacheEvictions(
      [record({ threadId: "huge", sizeChars: 50_000 }), record({ threadId: "small" })],
      { nowEpochMs: NOW, totalBudgetChars: 1_000_000, perThreadCapChars: 10_000 },
    );

    expect(plan.evictKeys).toEqual([threadCacheKey("env-1", "huge")]);
  });

  it("never evicts a thread opened inside the protected window", () => {
    const plan = selectThreadCacheEvictions(
      [
        record({ threadId: "recent", lastOpenedAtEpochMs: NOW - DAY_MS }),
        record({ threadId: "stale", lastOpenedAtEpochMs: NOW - 90 * DAY_MS }),
      ],
      { nowEpochMs: NOW, totalBudgetChars: 500 },
    );

    expect(plan.evictKeys).toContain(threadCacheKey("env-1", "stale"));
    expect(plan.evictKeys).not.toContain(threadCacheKey("env-1", "recent"));
    expect(DEFAULT_THREAD_CACHE_PROTECTED_WINDOW_MS).toBe(7 * DAY_MS);
  });

  it("never evicts a thread pinned by a handoff, however cold or large", () => {
    const plan = selectThreadCacheEvictions(
      [
        record({
          threadId: "pinned",
          sizeChars: 50_000,
          pinnedUntilEpochMs: NOW + 10 * DAY_MS,
        }),
      ],
      { nowEpochMs: NOW, totalBudgetChars: 100, perThreadCapChars: 1_000 },
    );

    expect(plan.evictKeys).toEqual([]);
    expect(plan.overBudget).toBe(true);
  });

  it("releases a pin once it has expired", () => {
    const plan = selectThreadCacheEvictions(
      [record({ threadId: "expired", pinnedUntilEpochMs: NOW - DAY_MS })],
      { nowEpochMs: NOW, totalBudgetChars: 100 },
    );

    expect(plan.evictKeys).toEqual([threadCacheKey("env-1", "expired")]);
  });

  it("keeps a parent whose child is still cached, so a lineage is not orphaned", () => {
    const plan = selectThreadCacheEvictions(
      [
        record({ threadId: "parent", lastOpenedAtEpochMs: NOW - 90 * DAY_MS }),
        record({ threadId: "other", lastOpenedAtEpochMs: NOW - 80 * DAY_MS }),
      ],
      {
        nowEpochMs: NOW,
        totalBudgetChars: 500,
        protectedKeys: new Set([threadCacheKey("env-1", "parent")]),
      },
    );

    expect(plan.evictKeys).toEqual([threadCacheKey("env-1", "other")]);
  });

  it("reports staying over budget rather than evicting protected threads", () => {
    const plan = selectThreadCacheEvictions(
      [record({ threadId: "recent", lastOpenedAtEpochMs: NOW })],
      { nowEpochMs: NOW, totalBudgetChars: 10 },
    );

    expect(plan.evictKeys).toEqual([]);
    expect(plan.overBudget).toBe(true);
  });
});

describe("cachedParentRefOf", () => {
  it("finds the lineage a cached snapshot points at", () => {
    expect(cachedParentRefOf('{"thread":{"parentThreadId":"thread-parent"}}')).toEqual({
      threadId: "thread-parent",
      environmentId: null,
    });
  });

  it("carries the machine a cross-environment parent lives on", () => {
    expect(
      cachedParentRefOf(
        '{"thread":{"parentThreadId":"thread-parent","parentEnvironmentId":"env-remote"}}',
      ),
    ).toEqual({ threadId: "thread-parent", environmentId: "env-remote" });
  });

  it("returns null for a root thread or an unreadable snapshot", () => {
    expect(cachedParentRefOf('{"thread":{"parentThreadId":null}}')).toBeNull();
    expect(cachedParentRefOf("{}")).toBeNull();
  });
});
