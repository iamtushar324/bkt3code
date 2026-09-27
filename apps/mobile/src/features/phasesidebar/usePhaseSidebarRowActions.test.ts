// T3-CUSTOM(expbkt3): fork-owned coverage for the row action set.
import { describe, expect, it } from "@effect/vitest";
import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";

import { buildPhaseSidebarRowActions } from "./usePhaseSidebarRowActions";

const NOW = "2026-08-31T12:00:00.000Z";

const row = (overrides: Partial<PhaseSidebarRow> = {}): PhaseSidebarRow =>
  ({
    thread: {
      id: "t1",
      session: null,
      snoozedUntil: null,
      settledOverride: null,
      settledAt: null,
      pinnedAt: null,
      updatedAt: NOW,
      ...overrides.thread,
    },
    settlementSupported: false,
    snoozeSupported: false,
    prioritySupported: false,
    ...overrides,
  }) as PhaseSidebarRow;

const ids = (r: PhaseSidebarRow) =>
  buildPhaseSidebarRowActions({ row: r, now: NOW }).map((action) => action.id);

describe("buildPhaseSidebarRowActions", () => {
  it("always offers People first — tagging is the common reason to long-press", () => {
    expect(ids(row())[0]).toBe("people");
  });

  it("offers only People, pin and archive against a server with no lifecycle support", () => {
    expect(ids(row())).toEqual(["people", "pin", "archive", "delete"]);
  });

  it("offers Settle when supported, and Reopen once settled", () => {
    expect(ids(row({ settlementSupported: true }))).toContain("settle");
    expect(
      ids(row({ settlementSupported: true, thread: { settledOverride: "settled" } as never })),
    ).toContain("unsettle");
  });

  it("offers Snooze when supported, and Wake while snoozed", () => {
    expect(ids(row({ snoozeSupported: true }))).toContain("snooze");
    expect(
      ids(
        row({
          snoozeSupported: true,
          thread: { snoozedUntil: "2099-01-01T00:00:00.000Z" } as never,
        }),
      ),
    ).toContain("unsnooze");
  });

  it("flips pin to unpin for a pinned thread", () => {
    expect(ids(row())).toContain("pin");
    expect(ids(row({ thread: { pinnedAt: NOW } as never }))).toContain("unpin");
  });

  it("lists priority choices only when the server supports priority", () => {
    expect(ids(row()).some((id) => id.startsWith("priority:"))).toBe(false);
    expect(
      ids(row({ prioritySupported: true })).filter((id) => id.startsWith("priority:")).length,
    ).toBeGreaterThan(0);
  });

  it("offers force stop only while a session exists", () => {
    expect(ids(row())).not.toContain("force-stop");
    expect(ids(row({ thread: { session: { status: "running" } } as never }))).toContain(
      "force-stop",
    );
  });

  it("keeps the destructive actions last", () => {
    const actions = buildPhaseSidebarRowActions({
      row: row({ thread: { session: { status: "running" } } as never }),
      now: NOW,
    });
    expect(actions.at(-1)?.id).toBe("delete");
    expect(actions.filter((action) => action.destructive === true).map((a) => a.id)).toEqual([
      "force-stop",
      "archive",
      "delete",
    ]);
  });

  it("offers Move to group as a submenu only when custom groups are passed", () => {
    expect(ids(row())).not.toContain("group");
    const actions = buildPhaseSidebarRowActions({
      row: row(),
      now: NOW,
      customGroups: [{ id: "a", label: "Alpha" }],
      customGroupId: "a",
    });
    const group = actions.find((action) => action.id === "group");
    expect(group?.subactions?.map((action) => action.id)).toEqual([
      "group:a",
      "group:none",
      "group:new",
    ]);
    expect(group?.subactions?.[0]?.checked).toBe(true);
  });

  it("offers snooze presets as a submenu when given", () => {
    const actions = buildPhaseSidebarRowActions({
      row: row({ snoozeSupported: true }),
      now: NOW,
      snoozePresets: [
        { id: "hour", label: "In 1 hour", whenLabel: "1:00 PM", snoozedUntil: NOW },
      ] as never,
    });
    expect(actions.find((action) => action.id === "snooze")?.subactions?.[0]?.id).toBe(
      "snooze:hour",
    );
  });
});
