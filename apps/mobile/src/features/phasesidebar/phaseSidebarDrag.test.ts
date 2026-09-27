// T3-CUSTOM(expbkt3): fork-owned coverage for the drag drop rules.
//
// A bad drop re-parents real work, so these are exhaustive about the refusals
// rather than only the happy path.
import { describe, expect, it } from "@effect/vitest";
import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";

import { resolveDragIntent } from "./usePhaseSidebarDrag";
import {
  describePhaseSidebarDropRejection,
  measureSubtreeDepth,
  validateReorder,
  validateReparent,
} from "./phaseSidebarDrag";

const row = (
  id: string,
  overrides: {
    parentThreadId?: string | null;
    // T3-CUSTOM(expbkt3): the environment a named parent lives on.
    parentEnvironmentId?: string | null;
    environmentId?: string;
    pinnedAt?: string | null;
  } = {},
): PhaseSidebarRow =>
  ({
    thread: {
      id,
      environmentId: overrides.environmentId ?? "env-1",
      parentThreadId: overrides.parentThreadId ?? null,
      parentEnvironmentId: overrides.parentEnvironmentId ?? null,
      pinnedAt: overrides.pinnedAt ?? null,
    },
  }) as PhaseSidebarRow;

describe("validateReparent", () => {
  it("allows a plain root-to-child move", () => {
    const subject = row("a");
    const target = row("b");
    expect(
      validateReparent({ subject, target, allRows: [subject, target], targetDepth: 0 }),
    ).toEqual({ allowed: true });
  });

  it("refuses dropping a row on itself", () => {
    const subject = row("a");
    expect(
      validateReparent({ subject, target: subject, allRows: [subject], targetDepth: 0 }),
    ).toMatchObject({ allowed: false, reason: "same-thread" });
  });

  it("refuses a cross-environment parent", () => {
    const subject = row("a");
    const target = row("b", { environmentId: "env-2" });
    expect(
      validateReparent({ subject, target, allRows: [subject, target], targetDepth: 0 }),
    ).toMatchObject({ allowed: false, reason: "cross-environment" });
  });

  it("refuses a move to the parent it already has", () => {
    const subject = row("a", { parentThreadId: "b" });
    const target = row("b");
    expect(
      validateReparent({ subject, target, allRows: [subject, target], targetDepth: 0 }),
    ).toMatchObject({ allowed: false, reason: "already-parent" });
  });

  it("refuses nesting a row under its own descendant", () => {
    const subject = row("a");
    const child = row("b", { parentThreadId: "a" });
    const grandchild = row("c", { parentThreadId: "b" });
    expect(
      validateReparent({
        subject,
        target: grandchild,
        allRows: [subject, child, grandchild],
        targetDepth: 2,
      }),
    ).toMatchObject({ allowed: false, reason: "own-descendant" });
  });

  // T3-CUSTOM(expbkt3): BEGIN — lineage is a (environment, thread) pair, so the
  // guards must not be fooled by an id that also exists on another machine.
  it("still refuses a descendant reached through another environment", () => {
    const subject = row("a");
    const remoteChild = row("b", {
      environmentId: "env-2",
      parentThreadId: "a",
      parentEnvironmentId: "env-1",
    });
    const localGrandchild = row("c", {
      parentThreadId: "b",
      parentEnvironmentId: "env-2",
    });

    expect(
      validateReparent({
        subject,
        target: localGrandchild,
        allRows: [subject, remoteChild, localGrandchild],
        targetDepth: 2,
      }),
    ).toMatchObject({ allowed: false, reason: "own-descendant" });
  });

  it("does not call a same-id parent on another machine the current parent", () => {
    // "b" on env-2 is the parent; the drop target is a different session that
    // merely shares its id, so this is a real move, not a no-op.
    const subject = row("a", { parentThreadId: "b", parentEnvironmentId: "env-2" });
    const localSameId = row("b");

    expect(
      validateReparent({
        subject,
        target: localSameId,
        allRows: [subject, localSameId],
        targetDepth: 0,
      }),
    ).toEqual({ allowed: true });
  });
  // T3-CUSTOM(expbkt3): END

  it("refuses a drop that would exceed the maximum tree depth", () => {
    const subject = row("a");
    const target = row("b");
    expect(
      validateReparent({ subject, target, allRows: [subject, target], targetDepth: 16 }),
    ).toMatchObject({ allowed: false, reason: "too-deep" });
  });

  it("counts the dragged subtree against the depth limit, not just the row", () => {
    const subject = row("a");
    const child = row("a1", { parentThreadId: "a" });
    const target = row("b");
    const allRows = [subject, child, target];
    // Depth 14 + 1 for the move + 1 level of subtree = 16, still allowed.
    expect(validateReparent({ subject, target, allRows, targetDepth: 14 })).toEqual({
      allowed: true,
    });
    // One deeper overflows.
    expect(validateReparent({ subject, target, allRows, targetDepth: 15 })).toMatchObject({
      allowed: false,
      reason: "too-deep",
    });
  });

  it("treats a null target as 'make this a root thread'", () => {
    const nested = row("a", { parentThreadId: "b" });
    expect(
      validateReparent({ subject: nested, target: null, allRows: [nested], targetDepth: 0 }),
    ).toEqual({ allowed: true });
  });

  it("refuses unparenting a row that is already a root", () => {
    const rootRow = row("a");
    expect(
      validateReparent({ subject: rootRow, target: null, allRows: [rootRow], targetDepth: 0 }),
    ).toMatchObject({ allowed: false, reason: "already-parent" });
  });
});

describe("measureSubtreeDepth", () => {
  it("is 0 for a leaf", () => {
    expect(measureSubtreeDepth([row("a")], "a")).toBe(0);
  });

  it("counts the deepest branch", () => {
    const rows = [
      row("a"),
      row("b", { parentThreadId: "a" }),
      row("c", { parentThreadId: "b" }),
      row("d", { parentThreadId: "a" }),
    ];
    expect(measureSubtreeDepth(rows, "a")).toBe(2);
  });

  it("does not hang on a cycle in server data", () => {
    const rows = [row("a", { parentThreadId: "b" }), row("b", { parentThreadId: "a" })];
    expect(measureSubtreeDepth(rows, "a")).toBeLessThan(10);
  });
});

describe("validateReorder", () => {
  it("refuses to reorder an unpinned row", () => {
    expect(
      validateReorder({ subject: row("a"), target: row("b", { pinnedAt: "t" }) }),
    ).toMatchObject({ allowed: false, reason: "not-pinned" });
  });

  it("refuses to reorder against an unpinned target", () => {
    expect(
      validateReorder({ subject: row("a", { pinnedAt: "t" }), target: row("b") }),
    ).toMatchObject({ allowed: false, reason: "not-pinned" });
  });

  it("allows reordering two pinned rows", () => {
    expect(
      validateReorder({
        subject: row("a", { pinnedAt: "t" }),
        target: row("b", { pinnedAt: "t" }),
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a cross-environment reorder", () => {
    expect(
      validateReorder({
        subject: row("a", { pinnedAt: "t" }),
        target: row("b", { pinnedAt: "t", environmentId: "env-2" }),
      }),
    ).toMatchObject({ allowed: false, reason: "cross-environment" });
  });
});

describe("describePhaseSidebarDropRejection", () => {
  it("has wording for every refusal", () => {
    for (const reason of [
      "same-thread",
      "cross-environment",
      "own-descendant",
      "already-parent",
      "too-deep",
      "not-pinned",
    ] as const) {
      expect(describePhaseSidebarDropRejection(reason).length).toBeGreaterThan(0);
    }
  });
});

describe("resolveDragIntent", () => {
  const rows = [
    { key: "a", geometry: { y: 0, height: 60, depth: 0 } },
    { key: "b", geometry: { y: 60, height: 60, depth: 1 } },
  ];

  it("re-parents when the finger is over the middle of a row", () => {
    expect(resolveDragIntent({ pointerY: 30, rows })).toEqual({
      kind: "reparent",
      targetKey: "a",
    });
  });

  it("reorders near the top edge of a row", () => {
    expect(resolveDragIntent({ pointerY: 2, rows })).toEqual({ kind: "reorder", targetKey: "a" });
  });

  it("reorders near the bottom edge of a row", () => {
    expect(resolveDragIntent({ pointerY: 58, rows })).toEqual({ kind: "reorder", targetKey: "a" });
  });

  it("resolves against the right row when several are stacked", () => {
    expect(resolveDragIntent({ pointerY: 90, rows })).toEqual({
      kind: "reparent",
      targetKey: "b",
    });
  });

  it("drops to root past the last row", () => {
    expect(resolveDragIntent({ pointerY: 500, rows })).toEqual({
      kind: "reparent",
      targetKey: null,
    });
  });

  it("drops to root when there are no rows at all", () => {
    expect(resolveDragIntent({ pointerY: 10, rows: [] })).toEqual({
      kind: "reparent",
      targetKey: null,
    });
  });
});
