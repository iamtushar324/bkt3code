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
  creditsView,
  formatUsd,
  nextPick,
  orderAccounts,
  paceLine,
  paceView,
  queueLabel,
  recoversIn,
  resetsIn,
  ringTone,
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
    ).toMatchObject({ id: "over", label: "over: five_hour 100% ≥ 90%" });
    // An excluded account past a trip line names the line, not the exclusion.
    expect(
      statusTag(
        account({ name: "x", eligible: false, why: "excluded", fiveHour: { usedPercent: 92 } }),
      ),
    ).toMatchObject({ id: "over", label: "over: five_hour 92% ≥ 90%" });
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
      { id: "fiveHour", label: "5-hour", used: 28, band: "ok", resetsIn: "resets in 2h 13m" },
      { id: "weekly", label: "Week", used: 60, band: "warn", resetsIn: null },
    ]);
    expect(rows[1]).toMatchObject({ current: false, disabled: true });
    expect(rows[1]?.windows.map((win) => win.label)).toEqual(["Week", "Fable"]);
  });

  it("hides accounts the viewer may not use, except the thread's own", () => {
    const rows = accountRows(
      snapshot([
        account({ name: "agent", allowed: true }),
        account({ name: "barsha", allowed: false }),
        account({ name: "tushar", allowed: false }),
      ]),
      thread({ resolvedProfile: "tushar" }),
      NOW,
    );
    expect(rows.map((row) => row.name)).toEqual(["agent", "tushar"]);
  });

  it("follows Auto's order and numbers only the accounts the viewer may use", () => {
    const rows = accountRows(
      snapshot([
        account({
          name: "tushar",
          eligible: false,
          why: "5-hour full in 1h 2m at this pace (37/h)",
          weekly: { usedPercent: 11, resetsAt: "2026-10-03T19:00:00.000Z" },
          spaceToReset: 68.5,
          spacePerDay: 46.6,
          fiveHourFullInSec: 3720,
          placeRank: 2,
        }),
        account({ name: "sam", auth: "logged_out" }),
        account({ name: "barsha", placeRank: 4 }),
        account({ name: "audit", placeRank: 3, allowed: false }),
        account({ name: "agent", placeRank: 1, spaceToReset: 97, spacePerDay: 14.1 }),
      ]),
      thread({ resolvedProfile: "audit" }),
      NOW,
    );
    expect(rows.map((row) => [row.name, row.pick])).toEqual([
      ["agent", 1],
      ["tushar", 2],
      ["audit", null],
      ["barsha", 3],
      ["sam", null],
    ]);
    expect(nextPick(rows)).toBe("agent");
    expect(rows[1]?.space).toEqual({ percent: 69, perDay: 47, resetsIn: "1d 11h" });
    expect(rows[1]?.tag).toMatchObject({ id: "filling", label: "5-hour full in 1h 2m" });
    expect(rows[3]?.space).toBeNull();
  });

  it("names Auto's next pick on the Auto row once the switcher ranks accounts", () => {
    const rows = accountRows(
      snapshot([account({ name: "agent", placeRank: 1 }), account({ name: "tushar" })]),
      null,
      NOW,
    );
    expect(autoRowDetail(null, rows)).toBe("Picks #1 agent on the first message");
    expect(autoRowDetail(thread({ resolvedProfile: "tushar" }), rows)).toBe(
      "On tushar · next new session → #1 agent",
    );
    expect(autoRowDetail(thread({ mode: { kind: "profile", profile: "tushar" } }), rows)).toBe(
      "Would pick #1 agent by space to reset",
    );
  });

  it("describes the Auto row before and after placement", () => {
    expect(autoRowDetail(null)).toBe("Picks an account on the first message");
    expect(autoRowDetail(thread({ resolvedProfile: "audit" }))).toBe(
      "On audit · new sessions go to the account with the most room",
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

describe("ringTone", () => {
  it("stays quiet below 75%, turns yellow from 75% and red from 90%", () => {
    expect(ringTone(null)).toBe("quiet");
    expect(ringTone(0)).toBe("quiet");
    expect(ringTone(74)).toBe("quiet");
    expect(ringTone(75)).toBe("warn");
    expect(ringTone(89)).toBe("warn");
    expect(ringTone(90)).toBe("bad");
    expect(ringTone(100)).toBe("bad");
  });
});

describe("queueLabel", () => {
  it("names the thread's place in the revive queue, and nothing when it is not waiting", () => {
    expect(queueLabel(null)).toBeNull();
    expect(queueLabel(thread({ resolvedProfile: "sam" }))).toBeNull();
    expect(
      queueLabel(
        thread({
          resolvedProfile: "sam",
          wait: {
            position: 2,
            queuedAt: "2026-10-02T07:55:00.000Z",
            expectedAt: "2026-10-02T08:31:00.000Z",
            expectedProfile: "agent",
            wasActive: true,
          },
        }),
      ),
    ).toBe("Waiting for an account · number 2 in the queue");
    expect(
      queueLabel(
        thread({
          wait: { position: 1, queuedAt: "2026-10-02T07:55:00.000Z", wasActive: false },
        }),
      ),
    ).toBe("No account free · number 1 in the queue");
  });
});

describe("pace to reset", () => {
  it("shows the projected percent and the status word", () => {
    const view = paceView(
      account({
        name: "agent",
        pace: { known: true, projectedPercent: 84.4, usedPercent: 40, status: "on_pace" },
      }),
    );
    expect(view).toEqual({ percent: 84, word: "on pace", tone: "muted" });
    expect(view && paceLine(view)).toBe("Pace to reset 84% · on pace");
  });

  it("uses the used percent for a spent cap and colours the words", () => {
    const spent = paceView(
      account({
        name: "agent",
        pace: { known: true, projectedPercent: 160, usedPercent: 100, status: "spent" },
      }),
    );
    expect(spent && paceLine(spent)).toBe("Pace to reset 100% · spent");
    expect(spent?.tone).toBe("bad");
    expect(
      paceView(
        account({ name: "a", pace: { known: true, projectedPercent: 130, status: "overused" } }),
      )?.tone,
    ).toBe("bad");
    expect(
      paceView(
        account({ name: "a", pace: { known: true, projectedPercent: 20, status: "underused" } }),
      ),
    ).toEqual({ percent: 20, word: "underused", tone: "good" });
    expect(
      paceView(
        account({ name: "a", pace: { known: true, projectedPercent: 0, status: "untouched" } }),
      ),
    ).toEqual({ percent: 0, word: "untouched", tone: "good" });
  });

  it("shows no pace line when the pace is unknown or absent", () => {
    expect(paceView(account({ name: "a" }))).toBeNull();
    expect(
      paceView(account({ name: "a", pace: { known: false, why: "no data", status: "unknown" } })),
    ).toBeNull();
    expect(
      paceView(
        account({ name: "a", pace: { known: true, projectedPercent: 50, status: "unknown" } }),
      ),
    ).toBeNull();
    expect(paceView(account({ name: "a", pace: { known: true, status: "on_pace" } }))).toBeNull();
  });

  it("puts the pace on the row and keeps the space to reset", () => {
    const [row] = accountRows(
      snapshot([
        account({
          name: "agent",
          spaceToReset: 60,
          spacePerDay: 20,
          pace: { known: true, projectedPercent: 84, status: "on_pace" },
        }),
      ]),
      null,
      NOW,
    );
    expect(row?.space).toMatchObject({ percent: 60, perDay: 20 });
    expect(row?.pace).toEqual({ percent: 84, word: "on pace", tone: "muted" });
    expect(row?.credits).toBeNull();
  });
});

describe("API credits", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  it("formats dollars with one decimal under $100 and none from $100", () => {
    expect(formatUsd(303.4)).toBe("$303");
    expect(formatUsd(500)).toBe("$500");
    expect(formatUsd(11.62)).toBe("$11.6");
    expect(formatUsd(65.2)).toBe("$65.2");
    expect(formatUsd(99.96)).toBe("$100");
    expect(formatUsd(0)).toBe("$0.0");
  });

  it("shows what is left, the expiry, and the allowed and actual daily spend", () => {
    const view = creditsView(
      account({
        name: "api",
        credits: {
          state: "ok",
          budgetUsd: 500,
          spentUsd: 197,
          leftUsd: 303,
          expiresAt: new Date(NOW + 26 * DAY + 5 * HOUR).toISOString(),
          daysLeft: 26.2,
          allowedUsdPerDay: 11.6,
          drrUsdPerDay: 65.2,
          runsOutAt: new Date(NOW + 4 * DAY + 16 * HOUR).toISOString(),
          status: "overused",
        },
      }),
      NOW,
    );
    expect(view).toEqual({
      headline: "Credits $303 left of $500 · expires in 26d",
      rate: "Allowed $11.6/day · actual $65.2/day · runs out in 4d 16h",
      tone: "bad",
    });
  });

  it("omits the runs-out part when the budget lasts past expiry", () => {
    const view = creditsView(
      account({
        name: "api",
        credits: {
          state: "ok",
          budgetUsd: 500,
          leftUsd: 450,
          daysLeft: 20,
          allowedUsdPerDay: 22.5,
          drrUsdPerDay: 3,
          status: "underused",
        },
      }),
      NOW,
    );
    expect(view).toEqual({
      headline: "Credits $450 left of $500 · expires in 20d",
      rate: "Allowed $22.5/day · actual $3.0/day",
      tone: "good",
    });
  });

  it("shows the detail when the figures cannot be read", () => {
    expect(
      creditsView(
        account({ name: "api", credits: { state: "no_admin_key", detail: "no admin key set" } }),
        NOW,
      ),
    ).toEqual({ headline: "Credits: no admin key set", rate: null, tone: "muted" });
    expect(
      creditsView(account({ name: "api", credits: { state: "pending" } }), NOW)?.headline,
    ).toBe("Credits: pending");
  });

  it("shows no credits lines on an account without credits", () => {
    const [row] = accountRows(snapshot([account({ name: "agent" })]), null, NOW);
    expect(row?.credits).toBeNull();
    expect(row?.pace).toBeNull();
  });
});
