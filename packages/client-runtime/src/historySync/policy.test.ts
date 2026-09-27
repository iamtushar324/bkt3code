import { describe, expect, it } from "@effect/vitest";

import {
  countUserTurns,
  DEFAULT_HISTORY_SYNC_BUDGET_USER_TURNS,
  shouldRequestOlderPage,
} from "./policy.ts";

const page = {
  beforeCursor: "cursor-1",
  hasMore: true,
  loadingOlder: false,
};

describe("shouldRequestOlderPage", () => {
  it("deepens a live thread that still has older history", () => {
    expect(shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 10 })).toBe(true);
  });

  it("waits until the thread is live", () => {
    for (const status of ["empty", "cached", "synchronizing", "deleted"] as const) {
      expect(shouldRequestOlderPage({ status, page, loadedUserTurns: 10 })).toBe(false);
    }
  });

  it("stops when the host has nothing older to give", () => {
    expect(
      shouldRequestOlderPage({
        status: "live",
        page: { ...page, hasMore: false },
        loadedUserTurns: 10,
      }),
    ).toBe(false);
    expect(shouldRequestOlderPage({ status: "live", page: null, loadedUserTurns: 10 })).toBe(false);
  });

  it("does not stack requests while a page is already in flight", () => {
    expect(
      shouldRequestOlderPage({
        status: "live",
        page: { ...page, loadingOlder: true },
        loadedUserTurns: 10,
      }),
    ).toBe(false);
  });

  it("has nothing to ask for without a cursor", () => {
    expect(
      shouldRequestOlderPage({
        status: "live",
        page: { ...page, beforeCursor: null },
        loadedUserTurns: 10,
      }),
    ).toBe(false);
  });

  it("stops at the budget so a cache never becomes an archive", () => {
    expect(
      shouldRequestOlderPage({
        status: "live",
        page,
        loadedUserTurns: DEFAULT_HISTORY_SYNC_BUDGET_USER_TURNS,
      }),
    ).toBe(false);
    expect(
      shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 5, budgetUserTurns: 5 }),
    ).toBe(false);
    expect(
      shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 4, budgetUserTurns: 5 }),
    ).toBe(true);
  });
});

// T3-CUSTOM(expbkt3): deepening waits for a quiet, visible thread.
describe("shouldRequestOlderPage while busy or hidden", () => {
  const page = { beforeCursor: "cursor-1", hasMore: true, loadingOlder: false };
  it("waits while a turn is running", () => {
    expect(
      shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 10, sessionRunning: true }),
    ).toBe(false);
    expect(
      shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 10, sessionRunning: false }),
    ).toBe(true);
  });
  it("waits while the window is hidden", () => {
    expect(
      shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 10, documentVisible: false }),
    ).toBe(false);
    expect(
      shouldRequestOlderPage({ status: "live", page, loadedUserTurns: 10, documentVisible: true }),
    ).toBe(true);
  });
});

describe("countUserTurns", () => {
  it("counts only what the pagination window is measured in", () => {
    expect(
      countUserTurns([
        { role: "user" },
        { role: "assistant" },
        { role: "user" },
        { role: "system" },
      ]),
    ).toBe(2);
    expect(countUserTurns([])).toBe(0);
  });
});
