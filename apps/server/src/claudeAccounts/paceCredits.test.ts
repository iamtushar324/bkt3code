import { describe, expect, it } from "@effect/vitest";

import { creditsFrom, paceAndCredits, paceFrom } from "./paceCredits.ts";

describe("paceFrom", () => {
  it("maps the switcher's pace object", () => {
    expect(
      paceFrom({
        known: true,
        why: "",
        cap: "weekly",
        elapsed_days: 3.2,
        used_pct: 38.5,
        drr_pct_per_day: 12,
        projected_pct: 84.2,
        status: "on_pace",
      }),
    ).toEqual({
      known: true,
      why: "",
      cap: "weekly",
      elapsedDays: 3.2,
      usedPercent: 38.5,
      drrPercentPerDay: 12,
      projectedPercent: 84.2,
      status: "on_pace",
    });
  });

  it("drops bad numbers and the whole object without a known status", () => {
    expect(
      paceFrom({ known: true, used_pct: "x", projected_pct: Number.NaN, status: "spent" }),
    ).toEqual({ known: true, status: "spent" });
    expect(paceFrom({ known: true, projected_pct: 80, status: "fast" })).toBeUndefined();
    expect(paceFrom({ projected_pct: 80, status: "on_pace" })).toBeUndefined();
    expect(paceFrom(null)).toBeUndefined();
    expect(paceFrom([1])).toBeUndefined();
  });
});

describe("creditsFrom", () => {
  it("maps the switcher's credits object", () => {
    expect(
      creditsFrom({
        state: "ok",
        detail: "",
        fetched_at_ms: 1_793_000_000_000,
        budget_usd: 500,
        spent_usd: 197,
        left_usd: 303,
        cycle_start: "2026-11-01",
        expires_at: "2026-12-01T00:00:00Z",
        days_left: 26,
        allowed_usd_per_day: 11.65,
        drr_usd_per_day: 65.2,
        runs_out_at: "2026-11-07T16:00:00Z",
        status: "overused",
      }),
    ).toEqual({
      state: "ok",
      detail: "",
      fetchedAtMs: 1_793_000_000_000,
      budgetUsd: 500,
      spentUsd: 197,
      leftUsd: 303,
      cycleStart: "2026-11-01",
      expiresAt: "2026-12-01T00:00:00.000Z",
      daysLeft: 26,
      allowedUsdPerDay: 11.65,
      drrUsdPerDay: 65.2,
      runsOutAt: "2026-11-07T16:00:00.000Z",
      status: "overused",
    });
  });

  it("drops nulls, bad dates and unknown enums", () => {
    expect(
      creditsFrom({
        state: "no_admin_key",
        detail: "no admin key",
        expires_at: null,
        runs_out_at: "soon",
        days_left: null,
        cycle_start: "November",
        status: "weird",
      }),
    ).toEqual({ state: "no_admin_key", detail: "no admin key" });
    expect(creditsFrom({ state: "broken" })).toBeUndefined();
    expect(creditsFrom(undefined)).toBeUndefined();
  });
});

describe("paceAndCredits", () => {
  const pace = { known: true, projected_pct: 50, status: "underused" };
  const credits = { state: "pending", detail: "fetching" };

  it("gives a seat its pace and never credits", () => {
    expect(paceAndCredits({ pace, credits })).toEqual({
      pace: { known: true, projectedPercent: 50, status: "underused" },
    });
  });

  it("gives the API fallback its credits and never a pace", () => {
    expect(paceAndCredits({ kind: "api_fallback", pace, credits })).toEqual({
      credits: { state: "pending", detail: "fetching" },
    });
  });

  it("adds nothing for an older switcher", () => {
    expect(paceAndCredits({})).toEqual({});
  });
});
