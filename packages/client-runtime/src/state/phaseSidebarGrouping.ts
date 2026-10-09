// T3-CUSTOM(expbkt3): how the phase sidebar is sectioned.
//
// The sidebar has always grouped by lifecycle phase. This module generalises
// that into three modes — lifecycle, project, and custom groups — and owns
// everything the modes share: the section model both clients render, which
// sections are collapsed, and the sanitizer that reads all of it back from
// storage.
//
// Custom groups are the thread's own `customGroup` label (see
// `ThreadCustomGroup` in contracts): shared between devices and people, and
// settable by an agent through the MCP control tools. A section's id is the
// label's comparison key (`phaseSidebarCustomGroupId`), so "Sprint 42" typed
// on the phone and "sprint 42" filed by an agent land in one section.
//
// What stays on the device is presentation only: the manual section order,
// which sections are collapsed, and the groups this device made before labels
// lived on the thread. Those legacy groups are still read — as a fallback for
// threads with no server label, so nobody loses their layout on upgrade, and
// as placeholders for groups that have no session yet — but every new
// placement is a `thread.meta.update { customGroup }` on the server.
//
// HERMES: this also runs under React Native. Sort a copy with `.sort()`,
// never `.toSorted()`.
import { normalizeThreadCustomGroup, THREAD_CUSTOM_GROUP_MAX_LENGTH } from "@t3tools/contracts";

import {
  isRunningSessionPhase,
  PHASE_SIDEBAR_UNGROUPED_ID,
  phaseSidebarCustomGroupIdForRow,
  resolvePhaseSidebarAttentionKind,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";
import {
  buildPhaseSidebarFilteredTree,
  buildPhaseSidebarTree,
  groupPhaseSidebarTreeByPhase,
  phaseSidebarRowKey,
  resolvePhaseSidebarTreePhase,
  type PhaseSidebarTreeNode,
} from "./phaseSidebarTree.ts";

export const PHASE_SIDEBAR_GROUP_BY_MODES = ["lifecycle", "project", "custom"] as const;
export type PhaseSidebarGroupBy = (typeof PHASE_SIDEBAR_GROUP_BY_MODES)[number];

export const PHASE_SIDEBAR_GROUP_BY_LABELS: Readonly<Record<PhaseSidebarGroupBy, string>> = {
  lifecycle: "Lifecycle",
  project: "Projects",
  custom: "Custom",
};

/**
 * How sections are ordered in the project and custom modes. Lifecycle keeps
 * its fixed, urgency-first order regardless.
 *
 * - manual: custom groups in the order the user arranged them (projects fall
 *   back to name, having no manual order).
 * - name: alphabetical.
 * - activity: the section with the most recently touched session first.
 */
export const PHASE_SIDEBAR_GROUP_ORDERS = ["manual", "name", "activity"] as const;
export type PhaseSidebarGroupOrder = (typeof PHASE_SIDEBAR_GROUP_ORDERS)[number];

export const PHASE_SIDEBAR_GROUP_ORDER_LABELS: Readonly<Record<PhaseSidebarGroupOrder, string>> = {
  manual: "Manual",
  name: "Name",
  activity: "Recent activity",
};

/**
 * A group this device made before labels lived on the thread. Read as a
 * fallback for threads with no server label, and as a placeholder section
 * while a group has no session; never the target of a new placement.
 */
export interface PhaseSidebarCustomGroup {
  readonly id: string;
  readonly label: string;
  /** Scoped thread keys, in no particular order; rows still sort by the row sort. */
  readonly threadKeys: ReadonlyArray<string>;
}

export { PHASE_SIDEBAR_UNGROUPED_ID };

export interface PhaseSidebarGroupingPreferences {
  readonly groupBy: PhaseSidebarGroupBy;
  readonly groupOrder: PhaseSidebarGroupOrder;
  readonly customGroups: ReadonlyArray<PhaseSidebarCustomGroup>;
  /** Custom section ids in the order the user arranged them; unlisted ids follow, by name. */
  readonly customGroupOrder: ReadonlyArray<string>;
  /** Section keys (see `PhaseSidebarSection.key`) the user closed. */
  readonly collapsedSectionKeys: ReadonlyArray<string>;
}

export const DEFAULT_PHASE_SIDEBAR_GROUPING: PhaseSidebarGroupingPreferences = {
  groupBy: "lifecycle",
  groupOrder: "manual",
  customGroups: [],
  customGroupOrder: [],
  collapsedSectionKeys: [],
};

/** Longest label a custom group keeps; the contract rejects anything past it. */
export const PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH = THREAD_CUSTOM_GROUP_MAX_LENGTH;

/** The section id for a label: what the filter facet and collapse state key on. */
export function phaseSidebarCustomGroupId(label: string): string {
  return normalizeThreadCustomGroup(label);
}

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

export function sanitizePhaseSidebarGroupLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, PHASE_SIDEBAR_GROUP_LABEL_MAX_LENGTH);
}

function sanitizeCustomGroups(value: unknown): PhaseSidebarCustomGroup[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const claimedThreadKeys = new Set<string>();
  const groups: PhaseSidebarCustomGroup[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as {
      readonly id?: unknown;
      readonly label?: unknown;
      readonly threadKeys?: unknown;
    };
    if (typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    if (candidate.id === PHASE_SIDEBAR_UNGROUPED_ID || seenIds.has(candidate.id)) continue;
    const label =
      typeof candidate.label === "string" ? sanitizePhaseSidebarGroupLabel(candidate.label) : "";
    if (label.length === 0) continue;
    seenIds.add(candidate.id);
    // A thread belongs to at most one group; the first claim wins so a
    // corrupted blob never renders one session twice.
    const threadKeys = sanitizeStringList(candidate.threadKeys).filter((key) => {
      if (claimedThreadKeys.has(key)) return false;
      claimedThreadKeys.add(key);
      return true;
    });
    groups.push({ id: candidate.id, label, threadKeys });
  }
  return groups;
}

export function sanitizePhaseSidebarGrouping(value: unknown): PhaseSidebarGroupingPreferences {
  if (value === null || typeof value !== "object") return DEFAULT_PHASE_SIDEBAR_GROUPING;
  const candidate = value as {
    readonly groupBy?: unknown;
    readonly groupOrder?: unknown;
    readonly customGroups?: unknown;
    readonly customGroupOrder?: unknown;
    readonly collapsedSectionKeys?: unknown;
  };
  const groupBy = PHASE_SIDEBAR_GROUP_BY_MODES.find((mode) => mode === candidate.groupBy);
  const groupOrder = PHASE_SIDEBAR_GROUP_ORDERS.find((order) => order === candidate.groupOrder);
  return {
    groupBy: groupBy ?? DEFAULT_PHASE_SIDEBAR_GROUPING.groupBy,
    groupOrder: groupOrder ?? DEFAULT_PHASE_SIDEBAR_GROUPING.groupOrder,
    customGroups: sanitizeCustomGroups(candidate.customGroups),
    customGroupOrder: sanitizeStringList(candidate.customGroupOrder).filter(
      (id) => id !== PHASE_SIDEBAR_UNGROUPED_ID,
    ),
    collapsedSectionKeys: sanitizeStringList(candidate.collapsedSectionKeys),
  };
}

// ---------------------------------------------------------------------------
// Editing — every operation is pure and returns the next preferences, so web's
// zustand store and mobile's preference file apply the same rules. Placing a
// session in a group is NOT here: that is a thread.meta.update on the server.
// ---------------------------------------------------------------------------

export function setPhaseSidebarGroupBy(
  preferences: PhaseSidebarGroupingPreferences,
  groupBy: PhaseSidebarGroupBy,
): PhaseSidebarGroupingPreferences {
  return preferences.groupBy === groupBy ? preferences : { ...preferences, groupBy };
}

export function setPhaseSidebarGroupOrder(
  preferences: PhaseSidebarGroupingPreferences,
  groupOrder: PhaseSidebarGroupOrder,
): PhaseSidebarGroupingPreferences {
  return preferences.groupOrder === groupOrder ? preferences : { ...preferences, groupOrder };
}

/** The section id a legacy local group renders under. */
function localGroupSectionId(group: PhaseSidebarCustomGroup): string {
  return phaseSidebarCustomGroupId(group.label);
}

/**
 * Registers an empty group on this device so it renders as a section before
 * any session is filed in it. Returns the section id, or null for a blank
 * label. A label that already exists (on the server or locally) is simply
 * returned: groups are keyed by label, so there is nothing to create.
 */
export function createPhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  input: { readonly label: string },
): { readonly preferences: PhaseSidebarGroupingPreferences; readonly id: string | null } {
  const label = sanitizePhaseSidebarGroupLabel(input.label);
  if (label.length === 0) return { preferences, id: null };
  const id = phaseSidebarCustomGroupId(label);
  if (preferences.customGroups.some((group) => localGroupSectionId(group) === id)) {
    return { preferences, id };
  }
  // The mode is left alone: a group made while grouping by lifecycle is
  // simply waiting when the user switches to Custom.
  return {
    preferences: {
      ...preferences,
      customGroups: [...preferences.customGroups, { id, label, threadKeys: [] }],
      customGroupOrder: preferences.customGroupOrder.includes(id)
        ? preferences.customGroupOrder
        : [...preferences.customGroupOrder, id],
    },
    id,
  };
}

/**
 * The device-side half of a rename: the server half is a bulk
 * thread.meta.update of the section's sessions. Moves the local placeholder,
 * the manual-order slot and the collapse state from the old id to the new one.
 */
export function renamePhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  id: string,
  label: string,
): PhaseSidebarGroupingPreferences {
  const nextLabel = sanitizePhaseSidebarGroupLabel(label);
  if (nextLabel.length === 0) return preferences;
  const nextId = phaseSidebarCustomGroupId(nextLabel);
  const affected = preferences.customGroups.filter((group) => localGroupSectionId(group) === id);
  const orderIndex = preferences.customGroupOrder.indexOf(id);
  const oldKey = phaseSidebarSectionKey("custom", id);
  const newKey = phaseSidebarSectionKey("custom", nextId);
  if (
    affected.length === 0 &&
    orderIndex === -1 &&
    !preferences.collapsedSectionKeys.includes(oldKey)
  ) {
    return preferences;
  }
  // Two local groups collapsing onto one label merge their fallback keys.
  const merged = new Set<string>();
  const customGroups: PhaseSidebarCustomGroup[] = [];
  for (const group of preferences.customGroups) {
    const sectionId = localGroupSectionId(group);
    if (sectionId !== id && sectionId !== nextId) {
      customGroups.push(group);
      continue;
    }
    for (const key of group.threadKeys) merged.add(key);
  }
  if (
    affected.length > 0 ||
    preferences.customGroups.some((g) => localGroupSectionId(g) === nextId)
  ) {
    customGroups.push({ id: nextId, label: nextLabel, threadKeys: [...merged] });
  }
  const customGroupOrder = preferences.customGroupOrder
    .map((entry) => (entry === id ? nextId : entry))
    .filter((entry, index, all) => all.indexOf(entry) === index);
  const collapsedSectionKeys = preferences.collapsedSectionKeys
    .map((key) => (key === oldKey ? newKey : key))
    .filter((key, index, all) => all.indexOf(key) === index);
  return { ...preferences, customGroups, customGroupOrder, collapsedSectionKeys };
}

/**
 * The device-side half of deleting a group: the server half is a bulk clear
 * of the section's sessions. Drops the local placeholder, its order slot and
 * its collapse state; nothing about the sessions themselves is lost.
 */
export function deletePhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  id: string,
): PhaseSidebarGroupingPreferences {
  const sectionKey = phaseSidebarSectionKey("custom", id);
  const customGroups = preferences.customGroups.filter(
    (group) => localGroupSectionId(group) !== id,
  );
  const customGroupOrder = preferences.customGroupOrder.filter((entry) => entry !== id);
  const collapsedSectionKeys = preferences.collapsedSectionKeys.filter((key) => key !== sectionKey);
  if (
    customGroups.length === preferences.customGroups.length &&
    customGroupOrder.length === preferences.customGroupOrder.length &&
    collapsedSectionKeys.length === preferences.collapsedSectionKeys.length
  ) {
    return preferences;
  }
  return { ...preferences, customGroups, customGroupOrder, collapsedSectionKeys };
}

/**
 * Moves a section one step within the manual order. `orderedIds` is the
 * custom section order currently on screen (Ungrouped excluded), which becomes
 * the stored order with the one swap applied — so a group that had no slot yet
 * gets one where the user saw it.
 */
export function movePhaseSidebarCustomGroup(
  preferences: PhaseSidebarGroupingPreferences,
  orderedIds: ReadonlyArray<string>,
  id: string,
  direction: "up" | "down",
): PhaseSidebarGroupingPreferences {
  const index = orderedIds.indexOf(id);
  if (index === -1) return preferences;
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= orderedIds.length) return preferences;
  const customGroupOrder = [...orderedIds];
  const [moved] = customGroupOrder.splice(index, 1);
  customGroupOrder.splice(target, 0, moved!);
  return { ...preferences, customGroupOrder };
}

/** The legacy local group label a thread falls back to when it has no server label. */
export function phaseSidebarLocalCustomGroupForThread(
  preferences: PhaseSidebarGroupingPreferences,
  threadKey: string,
): string | null {
  for (const group of preferences.customGroups) {
    if (group.threadKeys.includes(threadKey)) return group.label;
  }
  return null;
}

export function togglePhaseSidebarSectionCollapsed(
  preferences: PhaseSidebarGroupingPreferences,
  sectionKey: string,
): PhaseSidebarGroupingPreferences {
  const collapsed = preferences.collapsedSectionKeys.includes(sectionKey);
  return {
    ...preferences,
    collapsedSectionKeys: collapsed
      ? preferences.collapsedSectionKeys.filter((key) => key !== sectionKey)
      : [...preferences.collapsedSectionKeys, sectionKey],
  };
}

/**
 * Drops legacy thread keys that no longer exist on any connected environment,
 * so a fallback group does not carry ghosts forever. Only call this with the
 * FULL set of live keys — a partial set (one environment offline) would strip
 * real membership. Archived threads count as live: they can come back.
 */
export function prunePhaseSidebarGrouping(
  preferences: PhaseSidebarGroupingPreferences,
  liveThreadKeys: ReadonlySet<string>,
): PhaseSidebarGroupingPreferences {
  let changed = false;
  const customGroups = preferences.customGroups.map((group) => {
    const threadKeys = group.threadKeys.filter((key) => liveThreadKeys.has(key));
    if (threadKeys.length === group.threadKeys.length) return group;
    changed = true;
    return { ...group, threadKeys };
  });
  return changed ? { ...preferences, customGroups } : preferences;
}

// ---------------------------------------------------------------------------
// The group registry — every custom group in view, for menus and sections
// ---------------------------------------------------------------------------

export interface PhaseSidebarCustomGroupOption {
  readonly id: string;
  readonly label: string;
  /** Sessions among `rows` filed here (fallback placements included). */
  readonly count: number;
}

/**
 * The distinct custom groups across `rows` plus this device's empty
 * placeholders, in manual order: the stored order first, then legacy local
 * groups in their own order, then everything else by name. The display label
 * is the first spelling met, so a section's name is stable while the group
 * exists.
 */
export function listPhaseSidebarCustomGroups(
  rows: ReadonlyArray<PhaseSidebarRow>,
  preferences: PhaseSidebarGroupingPreferences,
): ReadonlyArray<PhaseSidebarCustomGroupOption> {
  const byId = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    if (row.thread.archivedAt !== null) continue;
    const id = phaseSidebarCustomGroupIdForRow(row);
    if (id === null || id === PHASE_SIDEBAR_UNGROUPED_ID) continue;
    const existing = byId.get(id);
    if (existing) existing.count += 1;
    else byId.set(id, { label: row.customGroup ?? id, count: 1 });
  }
  for (const group of preferences.customGroups) {
    const id = localGroupSectionId(group);
    if (id === PHASE_SIDEBAR_UNGROUPED_ID || byId.has(id)) continue;
    byId.set(id, { label: group.label, count: 0 });
  }
  const rank = new Map<string, number>();
  for (const id of preferences.customGroupOrder) if (!rank.has(id)) rank.set(id, rank.size);
  for (const group of preferences.customGroups) {
    const id = localGroupSectionId(group);
    if (!rank.has(id)) rank.set(id, rank.size);
  }
  const options = [...byId.entries()].map(([id, entry]) => ({ id, ...entry }));
  options.sort((left, right) => {
    const byRank =
      (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    return byRank !== 0 ? byRank : left.label.localeCompare(right.label);
  });
  return options;
}

// ---------------------------------------------------------------------------
// Sections — what the list renders
// ---------------------------------------------------------------------------

export function phaseSidebarSectionKey(kind: PhaseSidebarGroupBy, id: string): string {
  return `${kind}:${id}`;
}

/** What a closed section still has to say for itself. */
export interface PhaseSidebarSectionSummary {
  readonly running: number;
  readonly attention: number;
  readonly unread: number;
}

export interface PhaseSidebarSection {
  readonly key: string;
  readonly kind: PhaseSidebarGroupBy;
  readonly id: string;
  readonly label: string;
  readonly helperText: string;
  /** Set for lifecycle sections, which keep their phase tone. */
  readonly phaseId: PhaseSidebarPhaseId | null;
  readonly nodes: ReadonlyArray<PhaseSidebarTreeNode>;
  readonly summary: PhaseSidebarSectionSummary;
  /** True for the custom-mode catch-all, which cannot be renamed or deleted. */
  readonly isUngrouped: boolean;
  /**
   * Parked shelves (snoozed, settled) start closed: out of the way, never
   * gone. `collapsedSectionKeys` then records a toggle AWAY from this default,
   * so one list serves both kinds of section.
   */
  readonly collapsedByDefault: boolean;
}

export interface PhaseSidebarSectionsResult {
  readonly sections: ReadonlyArray<PhaseSidebarSection>;
  readonly forcedExpansionKeys: ReadonlySet<string>;
}

export interface BuildPhaseSidebarSectionsInput {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly filters: PhaseSidebarFilters;
  readonly compareSiblings: (left: PhaseSidebarRow, right: PhaseSidebarRow) => number;
  readonly titleForKey?: (key: string) => string | null;
  readonly grouping: PhaseSidebarGroupingPreferences;
  /** Project title lookup; falls back to the row's repository label. */
  readonly projectLabelFor?: (environmentId: string, projectId: string) => string | null;
  /**
   * Environment label, appended to project sections when more than one
   * environment is connected so two "t3code" projects on two machines read
   * apart.
   */
  readonly environmentLabelFor?: (environmentId: string) => string | null;
}

/**
 * What a collapsed header says it hides. Every pill counts top-level sessions,
 * the same unit as the header's total, so no pill can exceed it; a subtree
 * counts once, by what is anywhere inside it.
 */
function summarizeNodes(nodes: ReadonlyArray<PhaseSidebarTreeNode>): PhaseSidebarSectionSummary {
  let running = 0;
  let attention = 0;
  let unread = 0;
  for (const node of nodes) {
    const phaseId = resolvePhaseSidebarTreePhase(node);
    if (isRunningSessionPhase(phaseId)) running += 1;
    if (nodeWaitsOnHuman(node, phaseId)) attention += 1;
    if (node.row.isUnreadCompletion || node.descendantUnreadCount > 0) unread += 1;
  }
  return { running, attention, unread };
}

const HUMAN_WAIT_PHASE_IDS: ReadonlySet<PhaseSidebarPhaseId> = new Set<PhaseSidebarPhaseId>([
  "needs_input",
  "ask",
  "plan_ready",
]);

/**
 * Any kind of attention counts — input, approval, error, a question or a plan
 * to decide — on the row or below it. A row can hold an approval while it stays
 * filed under Implementing, so the phase alone is not enough. A plan the agent
 * is still working on is not a decision yet; plan_ready already covers the rest.
 */
function nodeWaitsOnHuman(node: PhaseSidebarTreeNode, phaseId: PhaseSidebarPhaseId): boolean {
  if (HUMAN_WAIT_PHASE_IDS.has(phaseId) || node.descendantAttention !== null) return true;
  const kind = resolvePhaseSidebarAttentionKind(node.row.thread);
  return kind !== null && kind !== "plan";
}

function latestActivity(nodes: ReadonlyArray<PhaseSidebarTreeNode>): number {
  let latest = Number.NEGATIVE_INFINITY;
  const visit = (node: PhaseSidebarTreeNode): void => {
    const at = Date.parse(node.row.thread.updatedAt ?? "");
    if (Number.isFinite(at) && at > latest) latest = at;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return latest;
}

function orderSections(
  sections: ReadonlyArray<PhaseSidebarSection>,
  order: PhaseSidebarGroupOrder,
  manualIndex: (section: PhaseSidebarSection) => number,
): ReadonlyArray<PhaseSidebarSection> {
  const sorted = [...sections];
  // The catch-all stays last in every order: it is where things go when they
  // have not been placed, not a peer of the groups the user made.
  const rank = (section: PhaseSidebarSection) => (section.isUngrouped ? 1 : 0);
  sorted.sort((left, right) => {
    const byRank = rank(left) - rank(right);
    if (byRank !== 0) return byRank;
    switch (order) {
      case "manual": {
        const byIndex = manualIndex(left) - manualIndex(right);
        return byIndex !== 0 ? byIndex : left.label.localeCompare(right.label);
      }
      case "name":
        return left.label.localeCompare(right.label);
      case "activity": {
        const byActivity = latestActivity(right.nodes) - latestActivity(left.nodes);
        return byActivity !== 0 ? byActivity : left.label.localeCompare(right.label);
      }
    }
  });
  return sorted;
}

function pluralSessions(count: number): string {
  return `${count} session${count === 1 ? "" : "s"}`;
}

export function buildPhaseSidebarSections(
  input: BuildPhaseSidebarSectionsInput,
): PhaseSidebarSectionsResult {
  const { tree, forcedExpansionKeys } = buildPhaseSidebarFilteredTree(input);
  const { grouping } = input;

  switch (grouping.groupBy) {
    case "lifecycle": {
      const sections = groupPhaseSidebarTreeByPhase(tree).map((group): PhaseSidebarSection => ({
        key: phaseSidebarSectionKey("lifecycle", group.id),
        kind: "lifecycle",
        id: group.id,
        label: group.label,
        helperText: group.helperText,
        phaseId: group.id,
        nodes: group.nodes,
        summary: summarizeNodes(group.nodes),
        isUngrouped: false,
        collapsedByDefault: false,
      }));
      return { sections, forcedExpansionKeys };
    }

    case "project": {
      const byProject = new Map<string, PhaseSidebarTreeNode[]>();
      for (const node of tree) {
        const { environmentId, projectId } = node.row.thread;
        const id = `${environmentId}:${projectId}`;
        byProject.set(id, [...(byProject.get(id) ?? []), node]);
      }
      const environmentIds = new Set(tree.map((node) => node.row.thread.environmentId));
      const sections = [...byProject.entries()].map(([id, nodes]): PhaseSidebarSection => {
        const first = nodes[0]!.row;
        const { environmentId, projectId } = first.thread;
        const label = input.projectLabelFor?.(environmentId, projectId) ?? first.repositoryLabel;
        const environmentLabel =
          environmentIds.size > 1 ? (input.environmentLabelFor?.(environmentId) ?? null) : null;
        return {
          key: phaseSidebarSectionKey("project", id),
          kind: "project",
          id,
          label,
          helperText: environmentLabel ?? pluralSessions(nodes.length),
          phaseId: null,
          nodes,
          summary: summarizeNodes(nodes),
          isUngrouped: false,
          collapsedByDefault: false,
        };
      });
      // Projects have no manual order, so "manual" reads as "name".
      return {
        sections: orderSections(
          sections,
          grouping.groupOrder === "manual" ? "name" : grouping.groupOrder,
          () => 0,
        ),
        forcedExpansionKeys,
      };
    }

    case "custom": {
      // The registry is built from every row handed in, filtered or not, so a
      // group whose sessions a filter hid still renders (empty) rather than
      // vanishing and reappearing as the filter changes.
      const registry = listPhaseSidebarCustomGroups(input.rows, grouping);
      // Placement is decided per ROOT: a child stays under its parent, which
      // is what nesting means. Filing a nested session moves nothing until it
      // is detached.
      const nodesById = new Map<string, PhaseSidebarTreeNode[]>();
      for (const node of tree) {
        const id = phaseSidebarCustomGroupIdForRow(node.row) ?? PHASE_SIDEBAR_UNGROUPED_ID;
        nodesById.set(id, [...(nodesById.get(id) ?? []), node]);
      }
      const sections: PhaseSidebarSection[] = registry.map((group) => {
        const nodes = nodesById.get(group.id) ?? [];
        return {
          key: phaseSidebarSectionKey("custom", group.id),
          kind: "custom",
          id: group.id,
          label: group.label,
          helperText: nodes.length === 0 ? "Empty" : pluralSessions(nodes.length),
          phaseId: null,
          nodes,
          summary: summarizeNodes(nodes),
          isUngrouped: false,
          collapsedByDefault: false,
        };
      });
      const ungrouped = nodesById.get(PHASE_SIDEBAR_UNGROUPED_ID) ?? [];
      if (ungrouped.length > 0) {
        sections.push({
          key: phaseSidebarSectionKey("custom", PHASE_SIDEBAR_UNGROUPED_ID),
          kind: "custom",
          id: PHASE_SIDEBAR_UNGROUPED_ID,
          label: "Ungrouped",
          helperText: "Not placed in a group yet",
          phaseId: null,
          nodes: ungrouped,
          summary: summarizeNodes(ungrouped),
          isUngrouped: true,
          collapsedByDefault: false,
        });
      }
      const manualIndex = new Map(registry.map((group, index) => [group.id, index]));
      return {
        sections: orderSections(
          sections,
          grouping.groupOrder,
          (section) => manualIndex.get(section.id) ?? Number.MAX_SAFE_INTEGER,
        ),
        forcedExpansionKeys,
      };
    }
  }
}

/** Whether a section is closed, honouring its default and the user's toggles. */
export function isPhaseSidebarSectionCollapsed(
  section: Pick<PhaseSidebarSection, "key" | "collapsedByDefault">,
  collapsedSectionKeys: ReadonlySet<string>,
): boolean {
  return collapsedSectionKeys.has(section.key) !== section.collapsedByDefault;
}

/** The parked shelves, by the row section they hold. */
export type PhaseSidebarShelfId = "snoozed" | "settled";

/**
 * The shelves' collapse identities. Web and mobile both read and toggle these
 * keys in `collapsedSectionKeys`, so a shelf the user closed stays closed on
 * every surface and across remounts. Shelves start closed; a key in the list
 * records that the user opened one.
 */
export const PHASE_SIDEBAR_SHELF_SECTIONS: Readonly<
  Record<PhaseSidebarShelfId, Pick<PhaseSidebarSection, "key" | "collapsedByDefault">>
> = {
  snoozed: { key: phaseSidebarSectionKey("lifecycle", "snoozed"), collapsedByDefault: true },
  settled: { key: phaseSidebarSectionKey("lifecycle", "settled"), collapsedByDefault: true },
};

/**
 * The parked shelves under the grouped sections: snoozed and settled sessions,
 * as flat lists in the order the caller partitioned them (wake time, then
 * settle time). They exist in every grouping mode — parking is orthogonal to
 * how live work is grouped — and start collapsed.
 */
export function buildPhaseSidebarShelfSections(input: {
  readonly snoozedRows: ReadonlyArray<PhaseSidebarRow>;
  readonly settledRows: ReadonlyArray<PhaseSidebarRow>;
}): ReadonlyArray<PhaseSidebarSection> {
  const keepOrder = (rows: ReadonlyArray<PhaseSidebarRow>) => {
    const index = new Map(rows.map((row, position) => [phaseSidebarRowKey(row), position]));
    return (left: PhaseSidebarRow, right: PhaseSidebarRow) =>
      (index.get(phaseSidebarRowKey(left)) ?? 0) - (index.get(phaseSidebarRowKey(right)) ?? 0);
  };
  const shelf = (
    id: PhaseSidebarShelfId,
    label: string,
    helperText: string,
    rows: ReadonlyArray<PhaseSidebarRow>,
  ): PhaseSidebarSection | null => {
    if (rows.length === 0) return null;
    const nodes = buildPhaseSidebarTree(rows, { compareSiblings: keepOrder(rows) });
    return {
      ...PHASE_SIDEBAR_SHELF_SECTIONS[id],
      kind: "lifecycle",
      id,
      label,
      helperText,
      phaseId: null,
      nodes,
      summary: summarizeNodes(nodes),
      isUngrouped: false,
    };
  };
  return [
    shelf("snoozed", "Snoozed", "Parked until they wake", input.snoozedRows),
    shelf("settled", "Settled", "Wrapped up", input.settledRows),
  ].filter((section): section is PhaseSidebarSection => section !== null);
}

/** Where a row's section sits in the list, for the collapsed-header phase tone. */
export function phaseSidebarSectionPhase(section: PhaseSidebarSection): PhaseSidebarPhaseId | null {
  if (section.phaseId !== null) return section.phaseId;
  if (section.summary.attention > 0) return "needs_input";
  if (section.summary.running > 0) return "implementing";
  return null;
}

/** Re-exported so callers grouping by hand can match the section builder. */
export { phaseSidebarCustomGroupIdForRow, phaseSidebarRowKey, resolvePhaseSidebarTreePhase };
