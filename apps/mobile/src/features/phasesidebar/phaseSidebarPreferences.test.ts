// T3-CUSTOM(expbkt3): fork-owned coverage for the sidebar's pure preference logic.
import { describe, expect, it } from "@effect/vitest";

import {
  pruneVisitTimestamps,
  removeVisitTimestamp,
  resolveMobileUnread,
  resolvePhaseSidebarEnabled,
} from "./phaseSidebarPreferences";

const at = (hour: number) => `2026-08-31T${String(hour).padStart(2, "0")}:00:00.000Z`;

describe("pruneVisitTimestamps", () => {
  it("leaves a map that fits under the cap untouched", () => {
    const visits = { a: at(1), b: at(2) };
    expect(pruneVisitTimestamps(visits, 5)).toBe(visits);
  });

  it("keeps the most recently visited threads when over the cap", () => {
    const pruned = pruneVisitTimestamps({ old: at(1), mid: at(2), fresh: at(3) }, 2);
    expect(Object.keys(pruned).sort()).toEqual(["fresh", "mid"]);
  });

  it("drops unparseable timestamps before real ones", () => {
    const pruned = pruneVisitTimestamps({ broken: "not-a-date", real: at(1) }, 1);
    expect(Object.keys(pruned)).toEqual(["real"]);
  });

  it("keeps exactly the cap when trimming", () => {
    const visits = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`t${index}`, at(index)]),
    );
    expect(Object.keys(pruneVisitTimestamps(visits, 4))).toHaveLength(4);
  });
});

describe("resolvePhaseSidebarEnabled", () => {
  it("is off while preferences are still loading", () => {
    expect(resolvePhaseSidebarEnabled({ preference: true, preferencesLoaded: false })).toBe(false);
  });

  it("is off for a device that has never chosen", () => {
    expect(resolvePhaseSidebarEnabled({ preference: undefined, preferencesLoaded: true })).toBe(
      false,
    );
  });

  it("is on only when explicitly enabled", () => {
    expect(resolvePhaseSidebarEnabled({ preference: true, preferencesLoaded: true })).toBe(true);
    expect(resolvePhaseSidebarEnabled({ preference: false, preferencesLoaded: true })).toBe(false);
  });
});

describe("resolveMobileUnread", () => {
  it("flags a completed session this device has never opened", () => {
    expect(
      resolveMobileUnread({
        sharedUnread: false,
        lastTurnCompletedAt: "2026-09-02T10:00:00.000Z",
        lastVisitedAt: undefined,
      }),
    ).toBe(true);
  });

  it("keeps a visited session read unless the shared rule disagrees", () => {
    expect(
      resolveMobileUnread({
        sharedUnread: false,
        lastTurnCompletedAt: "2026-09-02T10:00:00.000Z",
        lastVisitedAt: "2026-09-02T11:00:00.000Z",
      }),
    ).toBe(false);
    expect(
      resolveMobileUnread({ sharedUnread: true, lastTurnCompletedAt: null, lastVisitedAt: "x" }),
    ).toBe(true);
  });

  it("never flags a session with no completed turn", () => {
    expect(
      resolveMobileUnread({
        sharedUnread: false,
        lastTurnCompletedAt: null,
        lastVisitedAt: undefined,
      }),
    ).toBe(false);
  });
});

describe("removeVisitTimestamp", () => {
  it("drops the key and leaves the rest", () => {
    expect(removeVisitTimestamp({ a: "1", b: "2" }, "a")).toEqual({ b: "2" });
    const visits = { a: "1" };
    expect(removeVisitTimestamp(visits, "zzz")).toBe(visits);
  });
});
