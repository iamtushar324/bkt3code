// T3-CUSTOM(expbkt3): coverage for the sidebar's grouping modes and custom groups.
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PHASE_SIDEBAR_FILTERS,
  summarizeSidebarSessions,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";
import {
  buildPhaseSidebarSections,
  buildPhaseSidebarShelfSections,
  createPhaseSidebarCustomGroup,
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  deletePhaseSidebarCustomGroup,
  isPhaseSidebarSectionCollapsed,
  listPhaseSidebarCustomGroups,
  movePhaseSidebarCustomGroup,
  phaseSidebarLocalCustomGroupForThread,
  phaseSidebarSectionKey,
  prunePhaseSidebarGrouping,
  renamePhaseSidebarCustomGroup,
  sanitizePhaseSidebarGrouping,
  togglePhaseSidebarSectionCollapsed,
  type PhaseSidebarGroupingPreferences,
} from "./phaseSidebarGrouping.ts";
import { phaseSidebarRowKey } from "./phaseSidebarTree.ts";
import type { EnvironmentThreadShell as ThreadShell } from "./shell.ts";

const environmentId = EnvironmentId.make("environment-local");
const otherEnvironmentId = EnvironmentId.make("environment-remote");
const now = "2026-07-16T10:00:00.000Z";

function makeThread(id: string, overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: ProjectId.make("project-1"),
    ownerUserId: null,
    memberUserIds: [],
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestRun: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    runtime: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    priority: null,
    customGroup: null,
    linearIssueUrl: null,
    linearLinks: [],
    mattermostThreadUrl: null,
    parentThreadId: null,
    parentEnvironmentId: null,
    hasPendingAsyncUserInput: false,
    backgroundLiveness: null,
    activeProviderThreadId: null,
    source: {} as ThreadShell["source"],
    ...overrides,
  } as ThreadShell;
}

function makeRow(
  id: string,
  options: {
    readonly parent?: string | null;
    readonly phaseId?: PhaseSidebarPhaseId;
    readonly projectId?: string;
    readonly environmentId?: EnvironmentId;
    readonly updatedAt?: string;
    readonly unread?: boolean;
    readonly customGroup?: string | null;
  } = {},
): PhaseSidebarRow {
  const thread = makeThread(id, {
    ...(options.parent !== undefined
      ? { parentThreadId: options.parent === null ? null : ThreadId.make(options.parent) }
      : {}),
    ...(options.projectId !== undefined ? { projectId: ProjectId.make(options.projectId) } : {}),
    ...(options.environmentId !== undefined ? { environmentId: options.environmentId } : {}),
    ...(options.updatedAt !== undefined ? { updatedAt: options.updatedAt } : {}),
  });
  return {
    thread,
    phaseId: options.phaseId ?? "ready",
    repositoryKey: `repo-${options.projectId ?? "project-1"}`,
    repositoryLabel: `Repo ${options.projectId ?? "project-1"}`,
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    isOwnedByMe: false,
    participantUserIds: [],
    attentionPriority: 5,
    isUnreadCompletion: options.unread === true,
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    customGroup: options.customGroup ?? null,
    changeRequestState: null,
  };
}

const byId = (left: PhaseSidebarRow, right: PhaseSidebarRow) =>
  String(left.thread.id).localeCompare(String(right.thread.id));

const key = (id: string, env: EnvironmentId = environmentId) =>
  phaseSidebarRowKey(makeRow(id, { environmentId: env }));

function sections(
  rows: ReadonlyArray<PhaseSidebarRow>,
  grouping: PhaseSidebarGroupingPreferences,
  extra: Partial<Parameters<typeof buildPhaseSidebarSections>[0]> = {},
) {
  return buildPhaseSidebarSections({
    rows,
    filters: EMPTY_PHASE_SIDEBAR_FILTERS,
    compareSiblings: byId,
    grouping,
    ...extra,
  }).sections;
}

describe("buildPhaseSidebarSections", () => {
  it("lifecycle mode keeps the canonical phase order with phase tones", () => {
    const result = sections(
      [makeRow("a", { phaseId: "ready" }), makeRow("b", { phaseId: "needs_input" })],
      DEFAULT_PHASE_SIDEBAR_GROUPING,
    );
    expect(result.map((section) => section.id)).toEqual(["needs_input", "ready"]);
    expect(result[0]?.phaseId).toBe("needs_input");
    expect(result[0]?.key).toBe(phaseSidebarSectionKey("lifecycle", "needs_input"));
  });

  it("project mode groups roots by environment and project, sorted by name", () => {
    const result = sections(
      [
        makeRow("a", { projectId: "zeta" }),
        makeRow("b", { projectId: "alpha" }),
        makeRow("c", { projectId: "alpha", environmentId: otherEnvironmentId }),
      ],
      { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project" },
      {
        projectLabelFor: (_environmentId, projectId) => `Project ${projectId}`,
        environmentLabelFor: (id) => (id === otherEnvironmentId ? "Remote" : "Local"),
      },
    );
    expect(result.map((section) => section.label)).toEqual([
      "Project alpha",
      "Project alpha",
      "Project zeta",
    ]);
    // Two environments are connected, so the project sections carry the machine.
    expect(result.map((section) => section.helperText)).toEqual(["Local", "Remote", "Local"]);
    expect(result.every((section) => section.phaseId === null)).toBe(true);
  });

  it("project mode can order by recent activity", () => {
    const result = sections(
      [
        makeRow("a", { projectId: "old", updatedAt: "2026-07-01T00:00:00.000Z" }),
        makeRow("b", { projectId: "fresh", updatedAt: "2026-07-15T00:00:00.000Z" }),
      ],
      { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project", groupOrder: "activity" },
    );
    expect(result.map((section) => section.id)).toEqual([
      `${environmentId}:fresh`,
      `${environmentId}:old`,
    ]);
  });

  it("custom mode sections come from the threads' labels, case-insensitively, with Ungrouped last", () => {
    const grouping: PhaseSidebarGroupingPreferences = {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
      // An empty placeholder made on this device still renders as a section.
      customGroups: [{ id: "later", label: "Later", threadKeys: [] }],
      customGroupOrder: ["later"],
    };
    const result = sections(
      [
        makeRow("a", { customGroup: "Now" }),
        makeRow("b"),
        makeRow("remote", { environmentId: otherEnvironmentId, customGroup: "now" }),
      ],
      grouping,
    );
    expect(result.map((section) => [section.id, section.label, section.nodes.length])).toEqual([
      ["later", "Later", 0],
      ["now", "Now", 2],
      ["ungrouped", "Ungrouped", 1],
    ]);
    expect(result[2]?.isUngrouped).toBe(true);
    expect(result[0]?.helperText).toBe("Empty");
  });

  it("custom mode keeps a nested session under its parent even when labelled elsewhere", () => {
    const grouping: PhaseSidebarGroupingPreferences = {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
    };
    const result = sections(
      [makeRow("parent"), makeRow("child", { parent: "parent", customGroup: "Group" })],
      grouping,
    );
    expect(result.map((section) => [section.label, section.nodes.length])).toEqual([
      ["Group", 0],
      ["Ungrouped", 1],
    ]);
    expect(result[1]?.nodes[0]?.children).toHaveLength(1);
  });

  it("custom mode honours the manual order, then names the rest, while Ungrouped stays last", () => {
    const rows = [
      makeRow("x", { customGroup: "Zulu" }),
      makeRow("y", { customGroup: "Alpha" }),
      makeRow("w", { customGroup: "Mike" }),
      makeRow("z"),
    ];
    const manual = sections(rows, {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
      customGroupOrder: ["zulu"],
    });
    expect(manual.map((section) => section.label)).toEqual(["Zulu", "Alpha", "Mike", "Ungrouped"]);
    const byName = sections(rows, {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "custom",
      groupOrder: "name",
      customGroupOrder: ["zulu"],
    });
    expect(byName.map((section) => section.label)).toEqual(["Alpha", "Mike", "Zulu", "Ungrouped"]);
  });

  it("custom mode keeps a group whose only sessions a filter hid", () => {
    const result = buildPhaseSidebarSections({
      rows: [makeRow("a", { customGroup: "Hidden", phaseId: "ready" })],
      filters: { ...EMPTY_PHASE_SIDEBAR_FILTERS, phaseIds: ["needs_input"] },
      compareSiblings: byId,
      grouping: { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "custom" },
    }).sections;
    expect(result.map((section) => [section.label, section.nodes.length])).toEqual([["Hidden", 0]]);
  });

  it("summarises what a closed section hides", () => {
    const result = sections(
      [
        makeRow("a", { phaseId: "implementing" }),
        makeRow("b", { phaseId: "needs_input", unread: true }),
        makeRow("c", { parent: "a", phaseId: "planning" }),
      ],
      { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project" },
    );
    // One pill per top-level session: "a" with its planning child is one
    // running session, never two, so no pill exceeds the header total of 2.
    expect(result[0]?.summary).toEqual({ running: 1, attention: 1, unread: 1 });
  });

  it("counts a pending approval as attention even while the row stays in Implementing", () => {
    const busy = makeRow("a", { phaseId: "implementing" });
    const withApproval = { ...busy, thread: { ...busy.thread, hasPendingApprovals: true } };
    const result = sections([withApproval], {
      ...DEFAULT_PHASE_SIDEBAR_GROUPING,
      groupBy: "project",
    });
    expect(result[0]?.summary).toEqual({ running: 1, attention: 1, unread: 0 });
  });

  it("counts a parent once when only a child is unread", () => {
    const rows = [makeRow("a"), makeRow("b", { parent: "a", unread: true })];
    const result = sections(rows, { ...DEFAULT_PHASE_SIDEBAR_GROUPING, groupBy: "project" });
    expect(result[0]?.summary).toEqual({ running: 0, attention: 0, unread: 1 });
  });
});

describe("buildPhaseSidebarShelfSections", () => {
  it("builds collapsed-by-default snoozed and settled shelves in the given order", () => {
    const shelves = buildPhaseSidebarShelfSections({
      snoozedRows: [makeRow("b"), makeRow("a")],
      settledRows: [],
    });
    expect(shelves.map((section) => section.id)).toEqual(["snoozed"]);
    expect(shelves[0]?.collapsedByDefault).toBe(true);
    expect(shelves[0]?.nodes.map((node) => String(node.row.thread.id))).toEqual(["b", "a"]);
    // The toggle list records a move away from the default.
    expect(isPhaseSidebarSectionCollapsed(shelves[0]!, new Set())).toBe(true);
    expect(isPhaseSidebarSectionCollapsed(shelves[0]!, new Set([shelves[0]!.key]))).toBe(false);
  });
});

describe("custom group operations", () => {
  const base = DEFAULT_PHASE_SIDEBAR_GROUPING;

  it("creates an empty placeholder keyed by the label, without changing the mode", () => {
    const { preferences, id } = createPhaseSidebarCustomGroup(base, { label: "  Sprint   42  " });
    expect(id).toBe("sprint 42");
    expect(preferences.groupBy).toBe(base.groupBy);
    expect(preferences.customGroups).toEqual([{ id, label: "Sprint 42", threadKeys: [] }]);
    expect(preferences.customGroupOrder).toEqual(["sprint 42"]);
    // The same label again is the same group: nothing to create.
    expect(createPhaseSidebarCustomGroup(preferences, { label: "SPRINT 42" })).toEqual({
      preferences,
      id,
    });
  });

  it("refuses a blank label", () => {
    expect(createPhaseSidebarCustomGroup(base, { label: "   " })).toEqual({
      preferences: base,
      id: null,
    });
  });

  it("renames, reorders and deletes the device-side state", () => {
    let prefs = createPhaseSidebarCustomGroup(base, { label: "One" }).preferences;
    prefs = createPhaseSidebarCustomGroup(prefs, { label: "Two" }).preferences;
    prefs = togglePhaseSidebarSectionCollapsed(prefs, phaseSidebarSectionKey("custom", "one"));
    prefs = renamePhaseSidebarCustomGroup(prefs, "one", "Uno");
    expect(prefs.customGroups.map((group) => [group.id, group.label])).toEqual([
      ["two", "Two"],
      ["uno", "Uno"],
    ]);
    expect(prefs.customGroupOrder).toEqual(["uno", "two"]);
    expect(prefs.collapsedSectionKeys).toEqual([phaseSidebarSectionKey("custom", "uno")]);
    // A rename of a group this device never stored still moves its order slot.
    const serverOnly = renamePhaseSidebarCustomGroup(
      { ...base, customGroupOrder: ["alpha", "beta"] },
      "alpha",
      "Gamma",
    );
    expect(serverOnly.customGroupOrder).toEqual(["gamma", "beta"]);
    expect(serverOnly.customGroups).toEqual([]);

    prefs = movePhaseSidebarCustomGroup(prefs, ["uno", "two"], "two", "up");
    expect(prefs.customGroupOrder).toEqual(["two", "uno"]);
    expect(movePhaseSidebarCustomGroup(prefs, ["two", "uno"], "two", "up")).toBe(prefs);
    // A group with no slot yet gets one where the user saw it.
    expect(
      movePhaseSidebarCustomGroup(prefs, ["two", "uno", "new"], "new", "up").customGroupOrder,
    ).toEqual(["two", "new", "uno"]);

    prefs = deletePhaseSidebarCustomGroup(prefs, "uno");
    expect(prefs.customGroups.map((group) => group.id)).toEqual(["two"]);
    expect(prefs.customGroupOrder).toEqual(["two"]);
    // The deleted group's collapse state goes with it.
    expect(prefs.collapsedSectionKeys).toEqual([]);
    expect(deletePhaseSidebarCustomGroup(prefs, "missing")).toBe(prefs);
  });

  it("still reads a legacy local placement for the row builder's fallback", () => {
    const prefs: PhaseSidebarGroupingPreferences = {
      ...base,
      customGroups: [{ id: "g1", label: "Legacy", threadKeys: [key("a")] }],
    };
    expect(phaseSidebarLocalCustomGroupForThread(prefs, key("a"))).toBe("Legacy");
    expect(phaseSidebarLocalCustomGroupForThread(prefs, key("b"))).toBeNull();
  });

  it("lists every group in view with counts, in manual order", () => {
    const prefs: PhaseSidebarGroupingPreferences = {
      ...base,
      customGroups: [{ id: "g1", label: "Empty one", threadKeys: [] }],
      customGroupOrder: ["bugs"],
    };
    const rows = [
      makeRow("a", { customGroup: "Sprint 42" }),
      makeRow("b", { customGroup: "sprint 42" }),
      makeRow("c", { customGroup: "Bugs" }),
      makeRow("d"),
    ];
    expect(listPhaseSidebarCustomGroups(rows, prefs)).toEqual([
      { id: "bugs", label: "Bugs", count: 1 },
      { id: "empty one", label: "Empty one", count: 0 },
      { id: "sprint 42", label: "Sprint 42", count: 2 },
    ]);
  });

  it("collapse toggles round-trip", () => {
    const sectionKey = phaseSidebarSectionKey("lifecycle", "ready");
    const closed = togglePhaseSidebarSectionCollapsed(base, sectionKey);
    expect(closed.collapsedSectionKeys).toEqual([sectionKey]);
    expect(togglePhaseSidebarSectionCollapsed(closed, sectionKey).collapsedSectionKeys).toEqual([]);
  });

  it("pruning drops keys no environment knows", () => {
    const prefs: PhaseSidebarGroupingPreferences = {
      ...base,
      customGroups: [{ id: "g", label: "G", threadKeys: [key("live"), key("gone")] }],
    };
    const pruned = prunePhaseSidebarGrouping(prefs, new Set([key("live")]));
    expect(pruned.customGroups[0]?.threadKeys).toEqual([key("live")]);
    expect(prunePhaseSidebarGrouping(pruned, new Set([key("live")]))).toBe(pruned);
  });
});

describe("sanitizePhaseSidebarGrouping", () => {
  it("falls back to defaults for garbage", () => {
    expect(sanitizePhaseSidebarGrouping(null)).toEqual(DEFAULT_PHASE_SIDEBAR_GROUPING);
    expect(sanitizePhaseSidebarGrouping({ groupBy: "bogus", groupOrder: 3 })).toEqual(
      DEFAULT_PHASE_SIDEBAR_GROUPING,
    );
  });

  it("drops duplicate ids, reserved ids, blank labels and double-claimed threads", () => {
    const result = sanitizePhaseSidebarGrouping({
      groupBy: "custom",
      groupOrder: "name",
      customGroups: [
        { id: "a", label: "A", threadKeys: ["t1", "t2", 4] },
        { id: "a", label: "Dup", threadKeys: [] },
        { id: "ungrouped", label: "Reserved", threadKeys: [] },
        { id: "b", label: "   ", threadKeys: [] },
        { id: "c", label: "C", threadKeys: ["t2", "t3"] },
      ],
      customGroupOrder: ["a", "ungrouped", "a", 3],
      collapsedSectionKeys: ["custom:a", "custom:a", ""],
    });
    expect(result).toEqual({
      groupBy: "custom",
      groupOrder: "name",
      customGroups: [
        { id: "a", label: "A", threadKeys: ["t1", "t2"] },
        { id: "c", label: "C", threadKeys: ["t3"] },
      ],
      customGroupOrder: ["a"],
      collapsedSectionKeys: ["custom:a"],
    });
  });
});

describe("summarizeSidebarSessions unread", () => {
  it("counts sessions whose last turn finished after the viewer last opened them", () => {
    const seen = makeThread("seen", {
      latestRun: { completedAt: "2026-07-16T09:00:00.000Z" } as ThreadShell["latestRun"],
    });
    const unseen = makeThread("unseen", {
      latestRun: { completedAt: "2026-07-16T09:30:00.000Z" } as ThreadShell["latestRun"],
    });
    const counts = summarizeSidebarSessions([seen, unseen], {
      now,
      snoozeSupported: () => false,
      lastVisitedAtByThreadKey: {
        [key("seen")]: "2026-07-16T09:10:00.000Z",
        [key("unseen")]: "2026-07-16T09:00:00.000Z",
      },
    });
    expect(counts.unread).toBe(1);
    expect(counts.nonRunning).toBe(2);
    // Without visit data the count is zero, never a guess.
    expect(summarizeSidebarSessions([unseen], { now, snoozeSupported: () => false }).unread).toBe(
      0,
    );
  });
});
