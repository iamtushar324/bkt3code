import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountStatus,
  ThreadClaudeAccount,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountChips,
  accountRows,
  accountWarning,
  orderAccounts,
  remaining,
  resetsIn,
  switchRestartsCache,
  triggerTooltip,
  triggerView,
  unavailableLine,
} from "./model";

const NOW = Date.parse("2026-10-02T08:00:00.000Z");
const threadId = ThreadId.make("thread-1");

function account(overrides: Partial<ClaudeAccountStatus> & { name: string }): ClaudeAccountStatus {
  return {
    shortLabel: overrides.name.slice(0, 1),
    eligible: true,
    why: "",
    elected: false,
    auth: "ok",
    sessions: 0,
    ...overrides,
  };
}

function snapshot(profiles: ReadonlyArray<ClaudeAccountStatus>): ClaudeAccountsSnapshot {
  return {
    enabled: true,
    available: true,
    generatedAt: "2026-10-02T08:00:00.000Z",
    profiles: [...profiles],
  };
}

const agent = account({
  name: "agent",
  shortLabel: "a",
  emailMasked: "ag***@beknown.work",
  rank: 1,
  fiveHour: { usedPercent: 28, resetsAt: "2026-10-02T10:13:00.000Z" },
  weekly: { usedPercent: 60 },
  sessions: 2,
});

function thread(overrides: Partial<ThreadClaudeAccount>): ThreadClaudeAccount {
  return { threadId, mode: { kind: "auto" }, ...overrides };
}

describe("remaining", () => {
  it("turns percent used into percent left, clamped and rounded", () => {
    expect(remaining({ usedPercent: 60 })).toBe(40);
    expect(remaining({ usedPercent: 27.6 })).toBe(72);
    expect(remaining({ usedPercent: 140 })).toBe(0);
    expect(remaining(undefined)).toBeNull();
  });

  it("phrases the reset countdown", () => {
    expect(resetsIn({ usedPercent: 1, resetsAt: "2026-10-02T10:13:00.000Z" }, NOW)).toBe(
      "resets in 2h 13m",
    );
    expect(resetsIn({ usedPercent: 1, resetsAt: "2026-10-02T07:00:00.000Z" }, NOW)).toBe(
      "resets now",
    );
    expect(resetsIn({ usedPercent: 1 }, NOW)).toBeNull();
  });
});

describe("triggerView", () => {
  it("reads Auto until the server has placed the thread", () => {
    expect(triggerView(snapshot([agent]), null)).toEqual({ kind: "auto-unresolved" });
    expect(triggerView(snapshot([agent]), thread({}))).toEqual({ kind: "auto-unresolved" });
  });

  it("shows the placed account's badge and weekly limit left in Auto", () => {
    expect(triggerView(snapshot([agent]), thread({ resolvedProfile: "agent" }))).toEqual({
      kind: "account",
      profile: "agent",
      label: "a",
      weeklyRemaining: 40,
      fiveHourRemaining: 72,
      auto: true,
      warn: null,
    });
  });

  it("shows the pinned account even before a session has run on it", () => {
    const view = triggerView(
      snapshot([agent, account({ name: "sam", weekly: { usedPercent: 10 } })]),
      thread({ mode: { kind: "profile", profile: "sam" }, resolvedProfile: "agent" }),
    );
    expect(view).toMatchObject({
      kind: "account",
      profile: "sam",
      auto: false,
      weeklyRemaining: 90,
    });
  });

  it("warns on a logged-out, spent or nearly spent account", () => {
    const pinned = (profile: string) => thread({ mode: { kind: "profile", profile } });
    const accounts = snapshot([
      account({ name: "out", auth: "logged_out" }),
      account({ name: "spent", weekly: { usedPercent: 100 } }),
      account({ name: "near", fiveHour: { usedPercent: 85 } }),
    ]);
    expect(triggerView(accounts, pinned("out"))).toMatchObject({ warn: "logged_out" });
    expect(triggerView(accounts, pinned("spent"))).toMatchObject({ warn: "limit" });
    expect(triggerView(accounts, pinned("near"))).toMatchObject({ warn: "near" });
  });

  it("falls back to the name's first letter for an account the snapshot lacks", () => {
    expect(
      triggerView(snapshot([]), thread({ mode: { kind: "profile", profile: "tushar" } })),
    ).toMatchObject({ label: "t", weeklyRemaining: null, warn: null });
  });
});

describe("triggerTooltip", () => {
  it("names the mode, the account and both windows", () => {
    const accounts = snapshot([agent]);
    expect(triggerTooltip(triggerView(accounts, thread({ resolvedProfile: "agent" })))).toBe(
      "Auto (account) · on agent · weekly 40% left · 5-hour 72% left",
    );
    expect(
      triggerTooltip(
        triggerView(accounts, thread({ mode: { kind: "profile", profile: "agent" } })),
      ),
    ).toBe("agent (pinned) · weekly 40% left · 5-hour 72% left");
    expect(triggerTooltip({ kind: "auto-unresolved" })).toBe(
      "Auto (account) · picks an account when the thread starts",
    );
  });
});

describe("accountChips", () => {
  it("flags logged out, limits, a spent scoped allowance and live sessions", () => {
    const labels = (status: ClaudeAccountStatus) => accountChips(status).map((chip) => chip.label);
    expect(labels(account({ name: "x", auth: "logged_out" }))).toEqual(["logged out"]);
    expect(labels(account({ name: "x", fiveHour: { usedPercent: 100 } }))).toEqual(["at limit"]);
    expect(labels(account({ name: "x", eligible: false, why: "over weekly limit" }))).toEqual([
      "at limit",
    ]);
    expect(labels(account({ name: "x", fiveHour: { usedPercent: 80 } }))).toEqual(["near limit"]);
    expect(
      labels(account({ name: "x", scoped: { label: "Fable", usedPercent: 100 }, sessions: 3 })),
    ).toEqual(["Fable spent", "in use by 3"]);
  });

  it("does not call an account ineligible for other reasons at its limit", () => {
    const status = account({ name: "x", eligible: false, why: "busiest account" });
    expect(accountChips(status)).toEqual([]);
    expect(accountWarning(status)).toBeNull();
  });
});

describe("account rows", () => {
  it("orders by rank with unranked accounts last", () => {
    const ordered = orderAccounts([
      account({ name: "zed" }),
      account({ name: "sam", rank: 2 }),
      account({ name: "agent", rank: 1 }),
      account({ name: "barsha" }),
    ]);
    expect(ordered.map((status) => status.name)).toEqual(["agent", "sam", "barsha", "zed"]);
  });

  it("builds windows, checks the pinned account and disables logged-out ones", () => {
    const rows = accountRows(
      snapshot([
        account({ name: "out", auth: "logged_out", rank: 2 }),
        { ...agent, scoped: { label: "Fable", usedPercent: 50 } },
      ]),
      thread({ mode: { kind: "profile", profile: "agent" }, resolvedProfile: "agent" }),
      NOW,
    );
    expect(rows.map((row) => row.name)).toEqual(["agent", "out"]);
    const [first, second] = rows;
    expect(first).toMatchObject({ checked: true, current: true, disabled: false, sessions: 2 });
    expect(first?.windows).toEqual([
      { id: "fiveHour", label: "5h", remaining: 72, resetsIn: "resets in 2h 13m" },
      { id: "weekly", label: "Week", remaining: 40, resetsIn: null },
      { id: "scoped", label: "Fable", remaining: 50, resetsIn: null },
    ]);
    expect(second).toMatchObject({ checked: false, disabled: true, windows: [] });
  });
});

describe("switching", () => {
  it("warns about the prompt cache only when a pin leaves the current account", () => {
    const placed = thread({ resolvedProfile: "agent" });
    expect(switchRestartsCache(placed, { kind: "profile", profile: "sam" })).toBe(true);
    expect(switchRestartsCache(placed, { kind: "profile", profile: "agent" })).toBe(false);
    expect(switchRestartsCache(placed, { kind: "auto" })).toBe(false);
    expect(switchRestartsCache(thread({}), { kind: "profile", profile: "sam" })).toBe(false);
  });

  it("explains missing account data", () => {
    expect(unavailableLine(snapshot([]))).toBeNull();
    expect(
      unavailableLine({
        ...snapshot([]),
        available: false,
        unavailableReason: "claude-autoswitch not found",
      }),
    ).toBe(
      "Account data unavailable (claude-autoswitch not found) — Auto uses the host's current account",
    );
  });
});
