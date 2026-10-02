import type {
  ClaudeAccountsSnapshot,
  ClaudeAccountStatus,
  ThreadClaudeAccount,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  accountRows,
  accountWarning,
  autoRowDetail,
  orderAccounts,
  recoversIn,
  resetsIn,
  statusTag,
  switchRestartsSession,
  triggerTooltip,
  triggerView,
  unavailableLine,
  usageBand,
  used,
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

describe("used", () => {
  it("rounds and clamps percent used", () => {
    expect(used({ usedPercent: 27.6 })).toBe(28);
    expect(used({ usedPercent: 140 })).toBe(100);
    expect(used({ usedPercent: -3 })).toBe(0);
    expect(used(undefined)).toBeNull();
  });

  it("bands like the dashboard: green, amber from 60%, red at the trip line", () => {
    expect(usageBand(59, 90)).toBe("ok");
    expect(usageBand(60, 90)).toBe("warn");
    expect(usageBand(89, 90)).toBe("warn");
    expect(usageBand(90, 90)).toBe("bad");
    expect(usageBand(94, 95)).toBe("warn");
    expect(usageBand(95, 95)).toBe("bad");
  });

  it("phrases the reset countdown", () => {
    expect(resetsIn({ usedPercent: 1, resetsAt: "2026-10-02T10:13:00.000Z" }, NOW)).toBe(
      "resets 2h 13m",
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

  it("shows the placed account's badge and weekly % used, with its band", () => {
    const view = triggerView(snapshot([agent]), thread({ resolvedProfile: "agent" }));
    expect(view).toMatchObject({
      kind: "account",
      profile: "agent",
      label: "a",
      weeklyUsed: 60,
      weeklyBand: "warn",
      fiveHourUsed: 28,
      auto: true,
      warn: null,
    });
  });

  it("shows the pinned account even before a session has run on it", () => {
    const view = triggerView(
      snapshot([agent]),
      thread({ mode: { kind: "profile", profile: "agent" } }),
    );
    expect(view).toMatchObject({ kind: "account", profile: "agent", auto: false });
  });

  it("warns on a logged-out, over-limit or nearly spent account", () => {
    expect(accountWarning(account({ name: "x", auth: "logged_out" }))).toBe("logged_out");
    expect(accountWarning(account({ name: "x", weekly: { usedPercent: 99 } }))).toBe("limit");
    expect(accountWarning(account({ name: "x", fiveHour: { usedPercent: 92 } }))).toBe("limit");
    expect(accountWarning(account({ name: "x", fiveHour: { usedPercent: 83 } }))).toBe("near");
    expect(accountWarning(agent)).toBeNull();
  });

  it("falls back to the name's first letter for an account the snapshot lacks", () => {
    const view = triggerView(snapshot([]), thread({ resolvedProfile: "zed" }));
    expect(view).toMatchObject({ kind: "account", label: "z", weeklyUsed: null });
  });
});

describe("triggerTooltip", () => {
  it("names the mode, the account and both windows as % used", () => {
    expect(
      triggerTooltip(triggerView(snapshot([agent]), thread({ resolvedProfile: "agent" }))),
    ).toBe("Auto (account) · on agent · week 60% used · 5-hour 28% used");
    expect(triggerTooltip({ kind: "auto-unresolved" })).toBe(
      "Auto (account) · Picks an account on the first message",
    );
  });

  it("adds the reason for an account Auto would skip", () => {
    const audit = account({
      name: "audit",
      eligible: false,
      why: "over weekly 99% >= 95%",
      fiveHour: { usedPercent: 36 },
      weekly: { usedPercent: 99 },
    });
    expect(
      triggerTooltip(
        triggerView(snapshot([audit]), thread({ mode: { kind: "profile", profile: "audit" } })),
      ),
    ).toBe("audit (pinned) · week 99% used · 5-hour 36% used · over: weekly 99% ≥ 95%");
  });
});

describe("statusTag", () => {
  it("shows one tag, most severe first, in the dashboard's spelling", () => {
    expect(
      statusTag(account({ name: "x", auth: "logged_out", weekly: { usedPercent: 99 } })),
    ).toMatchObject({ id: "logged-out", tone: "bad" });
    expect(
      statusTag(
        account({
          name: "x",
          eligible: false,
          why: "over five_hour 94% >= 90%",
          fiveHour: { usedPercent: 94 },
        }),
      ),
    ).toMatchObject({ id: "over", label: "over: five_hour 94% ≥ 90%", tone: "bad" });
    expect(
      statusTag(account({ name: "x", eligible: false, fiveHour: { usedPercent: 100 } })),
    ).toMatchObject({ id: "over", label: "at limit" });
    expect(
      statusTag(
        account({
          name: "x",
          eligible: false,
          why: "near trip: five_hour 83% >= 80%",
          fiveHour: { usedPercent: 83 },
        }),
      ),
    ).toMatchObject({ id: "near-limit", tone: "warn", detail: "near trip: five_hour 83% ≥ 80%" });
    expect(
      statusTag(
        account({
          name: "x",
          eligible: false,
          why: "Fable cap spent (100%)",
          scoped: { label: "Fable", usedPercent: 100 },
        }),
      ),
    ).toMatchObject({ id: "scoped-spent", label: "Fable spent" });
    expect(statusTag(account({ name: "x", eligible: false, why: "excluded" }))).toMatchObject({
      id: "not-used",
      tone: "muted",
      detail: "excluded",
    });
    expect(statusTag(agent)).toBeNull();
  });

  it("says when an over-limit account recovers: the latest blocking reset", () => {
    const status = account({
      name: "x",
      fiveHour: { usedPercent: 95, resetsAt: "2026-10-02T09:04:00.000Z" },
      weekly: { usedPercent: 96, resetsAt: "2026-10-03T09:00:00.000Z" },
    });
    expect(recoversIn(status, NOW)).toBe("recovers 1d 1h");
    expect(
      recoversIn(
        account({ name: "y", fiveHour: { usedPercent: 94, resetsAt: "2026-10-02T09:04:00.000Z" } }),
        NOW,
      ),
    ).toBe("recovers 1h 4m");
    expect(recoversIn(agent, NOW)).toBeNull();
  });
});

describe("account rows", () => {
  it("lists usable accounts first, each group by rank", () => {
    const over = account({ name: "over", rank: 1, fiveHour: { usedPercent: 95 } });
    const second = account({ name: "second", rank: 2 });
    const unranked = account({ name: "unranked" });
    const out = account({ name: "out", rank: 3, auth: "logged_out" });
    expect(orderAccounts([out, unranked, over, second]).map((status) => status.name)).toEqual([
      "second",
      "unranked",
      "over",
      "out",
    ]);
  });

  it("builds % used windows with bands, marks the current account, disables logged-out", () => {
    const fable = account({
      name: "sam",
      rank: 2,
      weekly: { usedPercent: 74 },
      scoped: { label: "Fable", usedPercent: 70 },
      auth: "logged_out",
    });
    const rows = accountRows(
      snapshot([agent, fable]),
      thread({ mode: { kind: "profile", profile: "agent" }, resolvedProfile: "agent" }),
      NOW,
    );
    expect(rows.map((row) => row.name)).toEqual(["agent", "sam"]);
    expect(rows[0]).toMatchObject({ current: true, disabled: false, sessions: 2, tag: null });
    expect(rows[0]?.windows).toEqual([
      { id: "fiveHour", label: "5-hour", used: 28, band: "ok", resetsIn: "resets 2h 13m" },
      { id: "weekly", label: "Week", used: 60, band: "warn", resetsIn: null },
    ]);
    expect(rows[1]).toMatchObject({ current: false, disabled: true });
    expect(rows[1]?.windows.map((win) => win.label)).toEqual(["Week", "Fable"]);
  });

  it("describes the Auto row before and after placement", () => {
    expect(autoRowDetail(null)).toBe("Picks an account on the first message");
    expect(autoRowDetail(thread({ resolvedProfile: "audit" }))).toBe(
      "On audit · picks the least-busy account with room",
    );
  });
});

describe("switching", () => {
  it("restarts the session only when a pin leaves the current account", () => {
    const placed = thread({ resolvedProfile: "agent" });
    expect(switchRestartsSession(placed, { kind: "profile", profile: "sam" })).toBe(true);
    expect(switchRestartsSession(placed, { kind: "profile", profile: "agent" })).toBe(false);
    expect(switchRestartsSession(placed, { kind: "auto" })).toBe(false);
    expect(switchRestartsSession(thread({}), { kind: "profile", profile: "sam" })).toBe(false);
  });

  it("explains missing account data, and says loading before the first poll", () => {
    expect(unavailableLine(snapshot([account({ name: "agent" })]))).toBeNull();
    expect(unavailableLine({ ...snapshot([]), unavailableReason: "loading" })).toBe(
      "Loading account data…",
    );
    expect(unavailableLine(snapshot([]))).toBe("Loading account data…");
    expect(unavailableLine({ ...snapshot([]), available: false })).toBe("Loading account data…");
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
