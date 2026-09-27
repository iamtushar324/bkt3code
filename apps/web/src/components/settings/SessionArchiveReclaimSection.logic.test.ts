/**
 * T3-CUSTOM(expbkt3): Coverage for the reclaim panel's presentation logic.
 *
 * The selection summary is what enables the destructive buttons, so it gets the
 * most attention here — a blocked entry must never make one clickable.
 */
import {
  ProjectId,
  ThreadId,
  type SessionArchiveEntry,
  type SessionArchiveScanResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceProgress,
  applySelectionScope,
  describeProgress,
  describeReclaimResult,
  describeReclaimState,
  describeScanSummary,
  estimateActionBytes,
  formatBytes,
  initialProgress,
  progressPercent,
  projectGroups,
  selectionTargets,
  sortEntriesForDisplay,
  stateGroups,
  summarizeSelection,
} from "./SessionArchiveReclaimSection.logic";

const entry = (overrides: Partial<SessionArchiveEntry> = {}): SessionArchiveEntry =>
  ({
    threadId: ThreadId.make("thread_1"),
    projectId: ProjectId.make("project_1"),
    projectName: "A project",
    title: "A session",
    branch: "feature",
    worktreePath: "/worktrees/proj/feature",
    archivedAt: "2026-07-01T00:00:00.000Z",
    worktreeBytes: 1_000_000,
    reclaimableBytes: 800_000,
    reclaimState: "present",
    blockedReason: null,
    removeBlockedReason: null,
    historyPath: null,
    ...overrides,
  }) as SessionArchiveEntry;

describe("formatBytes", () => {
  it("reports a null size as unknown rather than zero", () => {
    expect(formatBytes(null)).toBe("size unknown");
  });

  it("keeps small counts in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  it("uses one decimal below ten and none above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(50 * 1024)).toBe("50 KB");
  });

  it("scales into gigabytes", () => {
    expect(formatBytes(3.6 * 1024 ** 3)).toBe("3.6 GB");
  });
});

describe("summarizeSelection", () => {
  it("counts only selected entries", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a") }),
      entry({ threadId: ThreadId.make("b") }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.selectedCount).toBe(1);
    expect(summary.reclaimableBytes).toBe(800_000);
  });

  it("never enables an action for a blocked entry", () => {
    // `worktree-live` is mode-independent, so the server reports it for both.
    const entries = [
      entry({
        threadId: ThreadId.make("a"),
        blockedReason: "worktree-live",
        removeBlockedReason: "worktree-live",
      }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.blockedCount).toBe(1);
    expect(summary.canSlim).toBe(false);
    expect(summary.canRemove).toBe(false);
  });

  it("excludes a blocked entry's bytes from the total", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), reclaimableBytes: 100 }),
      entry({
        threadId: ThreadId.make("b"),
        blockedReason: "worktree-shared",
        removeBlockedReason: "worktree-shared",
        reclaimableBytes: 900,
      }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a"), ThreadId.make("b")]));
    expect(summary.reclaimableBytes).toBe(100);
    expect(summary.eligibleCount).toBe(1);
  });

  it("keeps slim available for an already-slim worktree", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), reclaimState: "slimmed", reclaimableBytes: 0 }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.canSlim).toBe(true);
  });

  it("disables remove when nothing selected still has a worktree", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), worktreePath: null, reclaimState: "removed" }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.canRemove).toBe(false);
  });

  it("reports an empty selection as doing nothing", () => {
    const summary = summarizeSelection([entry()], new Set());
    expect(summary).toMatchObject({ selectedCount: 0, canSlim: false, canRemove: false });
  });
});

describe("sortEntriesForDisplay", () => {
  it("puts the biggest reclaim first", () => {
    const sorted = sortEntriesForDisplay([
      entry({ threadId: ThreadId.make("small"), reclaimableBytes: 10 }),
      entry({ threadId: ThreadId.make("big"), reclaimableBytes: 1000 }),
    ]);
    expect(sorted[0]?.threadId).toBe("big");
  });

  it("sorts unmeasured entries last", () => {
    const sorted = sortEntriesForDisplay([
      entry({ threadId: ThreadId.make("unknown"), reclaimableBytes: null, worktreeBytes: null }),
      entry({ threadId: ThreadId.make("known"), reclaimableBytes: 0, worktreeBytes: 0 }),
    ]);
    expect(sorted[0]?.threadId).toBe("known");
  });
});

describe("describeReclaimState", () => {
  it("names each state", () => {
    expect(describeReclaimState(entry({ reclaimState: "present" }))).toBe("Worktree on disk");
    expect(describeReclaimState(entry({ reclaimState: "slimmed" }))).toBe("Already slim");
    expect(describeReclaimState(entry({ reclaimState: "removed" }))).toBe("Worktree removed");
    expect(describeReclaimState(entry({ reclaimState: "missing" }))).toBe("Worktree missing");
  });
});

describe("describeReclaimResult", () => {
  it("reports what was freed", () => {
    expect(
      describeReclaimResult({
        mode: "slim",
        reclaimedCount: 3,
        skippedCount: 0,
        freedBytes: 2 * 1024 ** 3,
      }),
    ).toBe("Slimmed 3 sessions, freed 2.0 GB.");
  });

  it("mentions skipped sessions", () => {
    expect(
      describeReclaimResult({ mode: "remove", reclaimedCount: 1, skippedCount: 2, freedBytes: 0 }),
    ).toBe("Removed 1 session, 2 skipped.");
  });
});

describe("describeScanSummary", () => {
  it("summarizes the scan in one line", () => {
    const result = {
      scannedAt: "2026-08-07T00:00:00.000Z",
      entries: [
        entry({ threadId: ThreadId.make("a") }),
        entry({ threadId: ThreadId.make("b"), blockedReason: "worktree-live" }),
      ],
      orphanedWorktrees: [{ worktreePath: "/x", sizeBytes: null, lastModifiedAt: null }],
      totalReclaimableBytes: 800_000,
      historyDir: "/history",
      sizingIncomplete: true,
    } as SessionArchiveScanResult;
    const summary = describeScanSummary(result);
    expect(summary).toContain("2 archived sessions");
    expect(summary).toContain("1 reclaimable");
    expect(summary).toContain("1 orphaned worktrees");
    expect(summary).toContain("some sizes not measured");
  });
});

describe("summarizeSelection — force remove", () => {
  it("offers a plain remove only when the remove gate is clear", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), removeBlockedReason: "dirty-worktree" }),
    ];
    const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
    expect(summary.canRemove).toBe(false);
    expect(summary.canForceRemove).toBe(true);
    expect(summary.forceableCount).toBe(1);
  });

  it("counts unpushed commits as forceable too", () => {
    const entries = [
      entry({ threadId: ThreadId.make("a"), removeBlockedReason: "unpushed-commits" }),
    ];
    expect(summarizeSelection(entries, new Set([ThreadId.make("a")])).canForceRemove).toBe(true);
  });

  it("never offers force for a live or shared worktree", () => {
    for (const reason of ["worktree-live", "worktree-shared"] as const) {
      const entries = [entry({ threadId: ThreadId.make("a"), removeBlockedReason: reason })];
      const summary = summarizeSelection(entries, new Set([ThreadId.make("a")]));
      expect(summary.canForceRemove).toBe(false);
      expect(summary.forceableCount).toBe(0);
    }
  });

  it("counts cleanly removable plus forceable in the force total", () => {
    const entries = [
      entry({ threadId: ThreadId.make("clean") }),
      entry({ threadId: ThreadId.make("dirty"), removeBlockedReason: "dirty-worktree" }),
      entry({
        threadId: ThreadId.make("live"),
        blockedReason: "worktree-live",
        removeBlockedReason: "worktree-live",
      }),
    ];
    const summary = summarizeSelection(
      entries,
      new Set([ThreadId.make("clean"), ThreadId.make("dirty"), ThreadId.make("live")]),
    );
    expect(summary.forceRemoveCount).toBe(2);
  });
});

describe("selectionTargets", () => {
  const entries = [
    entry({ threadId: ThreadId.make("clean") }),
    entry({ threadId: ThreadId.make("dirty"), removeBlockedReason: "dirty-worktree" }),
    entry({
      threadId: ThreadId.make("live"),
      blockedReason: "worktree-live",
      removeBlockedReason: "worktree-live",
    }),
    entry({
      threadId: ThreadId.make("noslim"),
      blockedReason: "worktree-shared",
      removeBlockedReason: "worktree-shared",
    }),
  ];
  const all = new Set(entries.map((e) => e.threadId));

  it("sends only slim-eligible entries for a slim", () => {
    // `live` and `noslim` are held by mode-independent gates, so a slim skips
    // them too; `dirty` is fine to slim because slimming touches only
    // regenerable, git-ignored directories.
    expect(selectionTargets(entries, all, "slim")).toEqual(["clean", "dirty"]);
  });

  it("sends only cleanly removable entries for a plain remove", () => {
    expect(selectionTargets(entries, all, "remove")).toEqual(["clean"]);
  });

  it("adds forceable entries for a forced remove, never the live one", () => {
    const targets = selectionTargets(entries, all, "force-remove");
    expect(targets).toEqual(["clean", "dirty"]);
    expect(targets).not.toContain("live");
  });

  it("ignores entries that are not selected", () => {
    expect(selectionTargets(entries, new Set([ThreadId.make("clean")]), "slim")).toEqual(["clean"]);
  });

  it("never targets an entry whose worktree is already gone", () => {
    const gone = [entry({ threadId: ThreadId.make("gone"), worktreePath: null })];
    expect(selectionTargets(gone, new Set([ThreadId.make("gone")]), "force-remove")).toEqual([]);
  });
});

describe("applySelectionScope", () => {
  const entries = [
    entry({
      threadId: ThreadId.make("a"),
      projectId: ProjectId.make("p1"),
      reclaimState: "present",
    }),
    entry({
      threadId: ThreadId.make("b"),
      projectId: ProjectId.make("p2"),
      reclaimState: "slimmed",
    }),
    entry({
      threadId: ThreadId.make("c"),
      projectId: ProjectId.make("p1"),
      reclaimState: "present",
      blockedReason: "worktree-live",
    }),
  ] as ReadonlyArray<SessionArchiveEntry>;

  it("selects everything", () => {
    expect(applySelectionScope(entries, { kind: "all" }).size).toBe(3);
  });

  it("deselects everything", () => {
    expect(applySelectionScope(entries, { kind: "none" }).size).toBe(0);
  });

  it("selects only reclaimable entries", () => {
    const selected = applySelectionScope(entries, { kind: "reclaimable" });
    expect([...selected].sort()).toEqual(["a", "b"]);
  });

  it("selects by project", () => {
    const selected = applySelectionScope(entries, {
      kind: "project",
      projectId: ProjectId.make("p1"),
    });
    expect([...selected].sort()).toEqual(["a", "c"]);
  });

  it("selects by reclaim state", () => {
    const selected = applySelectionScope(entries, { kind: "state", state: "slimmed" });
    expect([...selected]).toEqual(["b"]);
  });

  it("replaces rather than accumulates", () => {
    const first = applySelectionScope(entries, {
      kind: "project",
      projectId: ProjectId.make("p1"),
    });
    const second = applySelectionScope(entries, {
      kind: "project",
      projectId: ProjectId.make("p2"),
    });
    expect([...second]).toEqual(["b"]);
    expect(first.has(ThreadId.make("a"))).toBe(true);
  });
});

describe("selection groups", () => {
  const entries = [
    entry({
      threadId: ThreadId.make("a"),
      projectId: ProjectId.make("p1"),
      reclaimState: "present",
    }),
    entry({
      threadId: ThreadId.make("b"),
      projectId: ProjectId.make("p1"),
      reclaimState: "present",
    }),
    entry({
      threadId: ThreadId.make("c"),
      projectId: ProjectId.make("p2"),
      reclaimState: "slimmed",
    }),
  ] as ReadonlyArray<SessionArchiveEntry>;

  it("groups projects by count, biggest first, using the name on the entry", () => {
    const named = [
      entry({
        threadId: ThreadId.make("a"),
        projectId: ProjectId.make("p1"),
        projectName: "t3code",
      }),
      entry({
        threadId: ThreadId.make("b"),
        projectId: ProjectId.make("p1"),
        projectName: "t3code",
      }),
      // Blank name: an older server that predates the field.
      entry({ threadId: ThreadId.make("c"), projectId: ProjectId.make("p2"), projectName: "" }),
    ];
    const groups = projectGroups(named);
    expect(groups[0]).toMatchObject({ id: "p1", label: "t3code", count: 2 });
    // A nameless project falls back to its id rather than disappearing.
    expect(groups[1]).toMatchObject({ id: "p2", label: "p2", count: 1 });
  });

  it("groups reclaim states with human labels", () => {
    const groups = stateGroups(entries);
    expect(groups[0]).toMatchObject({ id: "present", label: "Worktree on disk", count: 2 });
    expect(groups[1]).toMatchObject({ id: "slimmed", label: "Already slim", count: 1 });
  });
});

describe("reclaim progress", () => {
  const start = (over: Partial<Parameters<typeof initialProgress>[0]> = {}) =>
    initialProgress({ action: "slim", total: 4, estimatedBytes: 1000, ...over });

  it("starts empty", () => {
    expect(start()).toMatchObject({ completed: 0, freedBytes: 0, finished: false });
  });

  it("accumulates freed bytes and reclaimed counts", () => {
    let p = start();
    p = advanceProgress(p, { reclaimed: true, freedBytes: 250 });
    p = advanceProgress(p, { reclaimed: true, freedBytes: 250 });
    expect(p).toMatchObject({ completed: 2, freedBytes: 500, reclaimedCount: 2, skippedCount: 0 });
  });

  it("counts a skipped session without adding bytes", () => {
    const p = advanceProgress(start(), { reclaimed: false, freedBytes: 0 });
    expect(p).toMatchObject({ completed: 1, skippedCount: 1, reclaimedCount: 0, freedBytes: 0 });
  });

  describe("progressPercent", () => {
    it("tracks bytes against the estimate", () => {
      const p = { ...start(), completed: 1, freedBytes: 500 };
      expect(progressPercent(p)).toBe(50);
    });

    it("never exceeds the share of work actually completed", () => {
      // One huge worktree finishing first must not claim the bar is nearly full.
      const p = { ...start(), completed: 1, freedBytes: 999 };
      expect(progressPercent(p)).toBe(99);
    });

    it("clamps an overshooting estimate", () => {
      const p = { ...start(), completed: 3, freedBytes: 100_000 };
      expect(progressPercent(p)).toBe(99);
    });

    it("is full once every session is done, however the estimate compared", () => {
      const p = { ...start(), completed: 4, freedBytes: 1 };
      expect(progressPercent(p)).toBe(100);
    });

    it("falls back to session count when nothing was measured", () => {
      const p = { ...start({ estimatedBytes: null }), completed: 1 };
      expect(progressPercent(p)).toBe(25);
    });

    it("treats a zero estimate as unmeasured rather than dividing by zero", () => {
      const p = { ...start({ estimatedBytes: 0 }), completed: 2 };
      expect(progressPercent(p)).toBe(50);
    });

    it("reports an empty batch as complete", () => {
      expect(progressPercent(start({ total: 0 }))).toBe(100);
    });
  });

  describe("describeProgress", () => {
    it("names the session being worked on", () => {
      const p = { ...start(), completed: 1, freedBytes: 1024, currentTitle: "Fix resume" };
      const text = describeProgress(p);
      expect(text).toContain("Slimming 2 of 4");
      expect(text).toContain("1.0 KB freed");
      expect(text).toContain("Fix resume");
    });

    it("switches to a summary when finished", () => {
      const p = { ...start(), completed: 4, reclaimedCount: 3, skippedCount: 1, finished: true };
      const text = describeProgress(p);
      expect(text).toContain("Done · 3 of 4 reclaimed");
      expect(text).toContain("1 skipped");
      expect(text).not.toContain("Slimming");
    });

    it("says Removing for both removal actions", () => {
      expect(describeProgress(start({ action: "remove" }))).toContain("Removing");
      expect(describeProgress(start({ action: "force-remove" }))).toContain("Removing");
    });
  });
});

describe("estimateActionBytes", () => {
  const entries = [
    entry({ threadId: ThreadId.make("a"), reclaimableBytes: 100, worktreeBytes: 900 }),
    entry({ threadId: ThreadId.make("b"), reclaimableBytes: 200, worktreeBytes: 800 }),
  ];

  it("sums the reclaimable bytes for a slim", () => {
    expect(estimateActionBytes(entries, [ThreadId.make("a"), ThreadId.make("b")], "slim")).toBe(
      300,
    );
  });

  it("sums the whole worktree for a removal", () => {
    expect(estimateActionBytes(entries, [ThreadId.make("a")], "remove")).toBe(900);
    expect(estimateActionBytes(entries, [ThreadId.make("a")], "force-remove")).toBe(900);
  });

  it("ignores threads that are not targeted", () => {
    expect(estimateActionBytes(entries, [ThreadId.make("b")], "slim")).toBe(200);
  });

  it("returns null when nothing was measured", () => {
    const unmeasured = [
      entry({ threadId: ThreadId.make("a"), reclaimableBytes: null, worktreeBytes: null }),
    ];
    expect(estimateActionBytes(unmeasured, [ThreadId.make("a")], "slim")).toBeNull();
  });

  it("still totals the measured ones when some are unknown", () => {
    const mixed = [
      entry({ threadId: ThreadId.make("a"), reclaimableBytes: 100 }),
      entry({ threadId: ThreadId.make("b"), reclaimableBytes: null }),
    ];
    expect(estimateActionBytes(mixed, [ThreadId.make("a"), ThreadId.make("b")], "slim")).toBe(100);
  });
});
