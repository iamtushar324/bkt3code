// T3-CUSTOM(expbkt3): session trees for the phase-grouped session list.
//
// Moved out of apps/web so the mobile thread list can nest the same way; the
// web sidebar keeps a re-export shim at
// apps/web/src/components/sidebar/PhaseSidebarTree.logic.ts.
//
// HERMES: this also runs under React Native. Sort a copy with `.sort()`,
// never `.toSorted()`.
//
// A session that fans work out — typically cross-repo, via the t3_create_session
// MCP tool — records the session that spawned it. This module turns that flat
// `parentThreadId` link into the nested rows the sidebar renders, and decides
// which lifecycle group a parent belongs in once its children are folded into it.
import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";

import {
  matchesPhaseSidebarFilters,
  resolvePhaseSidebarAttentionKind,
  PHASE_SIDEBAR_PHASES,
  type PhaseSidebarAttentionKind,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseDefinition,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";

/**
 * Indentation stops growing past this depth. Deep chains still nest logically —
 * traversal, counts and the phase override all keep working — but the sidebar is
 * ~260px wide, so past three levels the indent costs more title than it buys in
 * legibility.
 */
export const PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH = 3;

/**
 * Backstop for a projection that already contains a cycle. The server rejects
 * commands that would create one, but a client must never hang on bad data.
 */
export const PHASE_SIDEBAR_TREE_MAX_DEPTH = 16;

/**
 * A descendant counts as "busy" when its own phase says an agent is actively
 * working. This is the single input to the parent's phase override.
 */
const BUSY_PHASE_IDS: ReadonlySet<PhaseSidebarPhaseId> = new Set<PhaseSidebarPhaseId>([
  "planning",
  "implementing",
]);

/**
 * Most-blocking first. A subtree can hold several stuck sessions at once, and
 * the parent has room for exactly one derived badge, so it reports the worst.
 */
// T3-CUSTOM(expbkt3): "plan" sits last — a waiting decision is the least
// blocking kind of attention, so it never masks a question below it.
const ATTENTION_RANK: ReadonlyArray<PhaseSidebarAttentionKind> = [
  "input",
  "approval",
  "error",
  // T3-CUSTOM(expbkt3): a question someone asked outranks a plan waiting to be
  // read, which is why the hoisted subtree lands in Ask rather than Plan Ready.
  "ask",
  "plan",
];

/**
 * A descendant needs a human when it is parked in the Needs Input phase or is
 * flying an attention badge of its own — a pending approval does not change a
 * session's phase, so both signals matter.
 */
function attentionKindOf(row: PhaseSidebarRow): PhaseSidebarAttentionKind | null {
  const kind = resolvePhaseSidebarAttentionKind(row.thread);
  // T3-CUSTOM(expbkt3): a plan held by a row that is still working is not a
  // decision yet, so it must not hoist a parent into Plan Ready.
  if (kind === "plan" && isBusy(row)) return null;
  if (kind !== null) return kind;
  if (row.phaseId === "needs_input") return "input";
  // T3-CUSTOM(expbkt3): same fallback for an async question and for a plan, so
  // a collapsed parent still reports what is hiding underneath it.
  if (row.phaseId === "ask") return "ask";
  return row.phaseId === "plan_ready" ? "plan" : null;
}

function moreUrgent(
  left: PhaseSidebarAttentionKind | null,
  right: PhaseSidebarAttentionKind | null,
): PhaseSidebarAttentionKind | null {
  if (left === null) return right;
  if (right === null) return left;
  return ATTENTION_RANK.indexOf(left) <= ATTENTION_RANK.indexOf(right) ? left : right;
}

export interface PhaseSidebarTreeNode {
  readonly row: PhaseSidebarRow;
  readonly key: string;
  readonly children: ReadonlyArray<PhaseSidebarTreeNode>;
  /** 0 for a root row; used for indentation and for the aria tree semantics. */
  readonly depth: number;
  /** Every descendant, not just direct children — this is the count the pill shows. */
  readonly descendantCount: number;
  /** True when any descendant is planning or implementing (see BUSY_PHASE_IDS). */
  readonly hasBusyDescendant: boolean;
  /**
   * How many descendants finished a turn the user has not read yet, and how
   * many have an agent working. Counts rather than the booleans above: a parent
   * with a wide fan-out needs to know whether one child or nine are waiting to
   * be read, and the number is the whole reason to open the subtree.
   */
  readonly descendantUnreadCount: number;
  readonly descendantRunningCount: number;
  /**
   * The most blocking thing any descendant is waiting on, or null. Drives both
   * the parent's group placement and its derived badge: work buried in a
   * collapsed subtree is invisible, so the parent has to raise its hand.
   */
  readonly descendantAttention: PhaseSidebarAttentionKind | null;
  /**
   * Set only on a row whose recorded parent is not rendering in this section —
   * archived, settled, filtered out, in another environment, or deleted. The row
   * renders at the top level with this breadcrumb instead of silently losing its
   * lineage.
   */
  readonly orphanedFrom: { readonly key: string; readonly title: string } | null;
}

export function phaseSidebarRowKey(row: PhaseSidebarRow): string {
  return scopedThreadKey(scopeThreadRef(row.thread.environmentId, row.thread.id));
}

/**
 * T3-CUSTOM(expbkt3): the parent link is a thread id plus the environment that
 * id belongs to. Historically it was a bare id, because a session could only be
 * created by a caller on the same server; a child may now name a parent on
 * another machine, so the id alone is ambiguous across connected environments.
 * An absent environment id means the child's own, which is what every
 * same-server link means and what older servers keep sending.
 */
function parentKeyOf(row: PhaseSidebarRow): string | null {
  const parentThreadId = row.thread.parentThreadId;
  if (parentThreadId == null) return null;
  const parentEnvironmentId = row.thread.parentEnvironmentId ?? row.thread.environmentId;
  return scopedThreadKey(scopeThreadRef(parentEnvironmentId, parentThreadId));
}

interface MutableNode {
  readonly row: PhaseSidebarRow;
  readonly key: string;
  readonly children: MutableNode[];
  depth: number;
  descendantCount: number;
  hasBusyDescendant: boolean;
  descendantUnreadCount: number;
  descendantRunningCount: number;
  descendantAttention: PhaseSidebarAttentionKind | null;
  orphanedFrom: { readonly key: string; readonly title: string } | null;
}

function isBusy(row: PhaseSidebarRow): boolean {
  return BUSY_PHASE_IDS.has(row.phaseId);
}

/**
 * Resolve the row's effective parent, or null when it should render as a root.
 *
 * A row nests only if its parent is present in the SAME row set. That one rule
 * absorbs every edge case — parent archived, settled, snoozed, filtered out,
 * deleted, or in another environment — without special-casing any of them, and
 * guarantees the result is a forest rooted in rows that actually render.
 */
function resolveParent(
  node: MutableNode,
  byKey: ReadonlyMap<string, MutableNode>,
): MutableNode | null {
  const parentKey = parentKeyOf(node.row);
  if (parentKey === null) return null;
  const parent = byKey.get(parentKey);
  if (parent === undefined || parent.key === node.key) return null;

  // Walk to the root before accepting the link. A cycle here means the stored
  // data is already corrupt; promoting the row to a root keeps the sidebar
  // usable instead of dropping the row or looping forever.
  const seen = new Set<string>([node.key]);
  let cursor: MutableNode | undefined = parent;
  for (let depth = 0; cursor !== undefined && depth < PHASE_SIDEBAR_TREE_MAX_DEPTH; depth += 1) {
    if (seen.has(cursor.key)) return null;
    seen.add(cursor.key);
    const nextKey = parentKeyOf(cursor.row);
    cursor = nextKey === null ? undefined : byKey.get(nextKey);
  }
  return cursor === undefined ? parent : null;
}

/**
 * Bottom-up rollup of the two derived facts a parent row renders: how many
 * sessions live under it, and whether any of them is doing work.
 */
function finalize(node: MutableNode, depth: number): void {
  node.depth = depth;
  let descendantCount = 0;
  let hasBusyDescendant = false;
  let descendantUnreadCount = 0;
  let descendantRunningCount = 0;
  let descendantAttention: PhaseSidebarAttentionKind | null = null;
  for (const child of node.children) {
    finalize(child, depth + 1);
    descendantCount += 1 + child.descendantCount;
    hasBusyDescendant = hasBusyDescendant || isBusy(child.row) || child.hasBusyDescendant;
    descendantUnreadCount += (child.row.isUnreadCompletion ? 1 : 0) + child.descendantUnreadCount;
    descendantRunningCount += (isBusy(child.row) ? 1 : 0) + child.descendantRunningCount;
    descendantAttention = moreUrgent(
      descendantAttention,
      moreUrgent(attentionKindOf(child.row), child.descendantAttention),
    );
  }
  node.descendantCount = descendantCount;
  node.hasBusyDescendant = hasBusyDescendant;
  node.descendantUnreadCount = descendantUnreadCount;
  node.descendantRunningCount = descendantRunningCount;
  node.descendantAttention = descendantAttention;
}

function freeze(node: MutableNode): PhaseSidebarTreeNode {
  return {
    row: node.row,
    key: node.key,
    children: node.children.map(freeze),
    depth: node.depth,
    descendantCount: node.descendantCount,
    hasBusyDescendant: node.hasBusyDescendant,
    descendantUnreadCount: node.descendantUnreadCount,
    descendantRunningCount: node.descendantRunningCount,
    descendantAttention: node.descendantAttention,
    orphanedFrom: node.orphanedFrom,
  };
}

/**
 * Build the forest for one sidebar section (active / snoozed / settled).
 *
 * `compareSiblings` orders both the returned roots and every child list, so a
 * subtree reads with the same ordering rules as the list it sits in.
 * `titleForKey` resolves orphan breadcrumbs against the full thread set, not
 * just this section, so "↳ Parent title" still names a settled or filtered
 * parent.
 */
export function buildPhaseSidebarTree(
  rows: ReadonlyArray<PhaseSidebarRow>,
  options: {
    readonly compareSiblings: (left: PhaseSidebarRow, right: PhaseSidebarRow) => number;
    readonly titleForKey?: (key: string) => string | null;
  },
): ReadonlyArray<PhaseSidebarTreeNode> {
  const nodes: MutableNode[] = rows.map((row) => ({
    row,
    key: phaseSidebarRowKey(row),
    children: [],
    depth: 0,
    descendantCount: 0,
    hasBusyDescendant: false,
    descendantUnreadCount: 0,
    descendantRunningCount: 0,
    descendantAttention: null,
    orphanedFrom: null,
  }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));

  const roots: MutableNode[] = [];
  for (const node of nodes) {
    const parent = resolveParent(node, byKey);
    if (parent === null) {
      const parentKey = parentKeyOf(node.row);
      if (parentKey !== null) {
        const title = options.titleForKey?.(parentKey) ?? null;
        if (title !== null) node.orphanedFrom = { key: parentKey, title };
      }
      roots.push(node);
      continue;
    }
    parent.children.push(node);
  }

  const sortRecursively = (list: MutableNode[]): void => {
    list.sort((left, right) => options.compareSiblings(left.row, right.row));
    for (const node of list) sortRecursively(node.children);
  };
  sortRecursively(roots);
  for (const root of roots) finalize(root, 0);

  return roots.map(freeze);
}

/**
 * The phase a ROOT row is grouped under.
 *
 * Precedence, most urgent first:
 *
 *   1. Anything in the subtree is blocked on a human  → Needs Input
 *   2. A question or a plan waits in the subtree       → Ask / Plan Ready
 *   3. Anything in the subtree is doing work          → Implementing
 *   4. Otherwise                                      → the row's own phase
 *
 * Attention outranks work because a collapsed subtree hides it completely: an
 * approval sitting two levels down under a parent filed as "Implementing" is
 * invisible until someone happens to expand the right row. Hoisting the parent
 * costs one row of churn and is the whole reason the Needs Input group is worth
 * scanning first.
 */
export function resolvePhaseSidebarTreePhase(node: PhaseSidebarTreeNode): PhaseSidebarPhaseId {
  // T3-CUSTOM(expbkt3): one rule for a row and its subtree. Needs Input means
  // an agent is blocked on a human (a question or an approval). A plan-only
  // subtree hoists to Plan Ready and an ask-only one to Ask, in their own
  // tones. A failure flies its ERROR badge but moves nothing, the same as a
  // failed top-level row. A row's own stronger phase is never downgraded by a
  // lighter child.
  const ownPhaseId = node.row.phaseId;
  if (ownPhaseId === "needs_input") return ownPhaseId;
  const attention = node.descendantAttention;
  if (attention === "input" || attention === "approval") return "needs_input";
  if (ownPhaseId === "ask" || attention === "ask") return "ask";
  if (attention === "plan") return "plan_ready";
  return node.hasBusyDescendant ? "implementing" : ownPhaseId;
}

export function flattenPhaseSidebarTree(
  nodes: ReadonlyArray<PhaseSidebarTreeNode>,
  isExpanded: (key: string) => boolean,
): ReadonlyArray<PhaseSidebarTreeNode> {
  const flattened: PhaseSidebarTreeNode[] = [];
  const visit = (node: PhaseSidebarTreeNode): void => {
    flattened.push(node);
    if (node.children.length === 0 || !isExpanded(node.key)) return;
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return flattened;
}

/** Every key in a subtree except its root — backs "Expand/Collapse all children". */
export function collectPhaseSidebarSubtreeKeys(node: PhaseSidebarTreeNode): ReadonlyArray<string> {
  const keys: string[] = [];
  const visit = (current: PhaseSidebarTreeNode): void => {
    for (const child of current.children) {
      keys.push(child.key);
      visit(child);
    }
  };
  visit(node);
  return keys;
}

/**
 * Keys of parents that must be force-expanded because a filter matched
 * something inside them. Without this, filtering by repository would silently
 * hide matches nested under a collapsed parent from another repository — the
 * exact cross-repo case this feature exists to make visible.
 */
export function resolveForcedExpansionKeys(
  nodes: ReadonlyArray<PhaseSidebarTreeNode>,
  matches: (row: PhaseSidebarRow) => boolean,
): ReadonlySet<string> {
  const forced = new Set<string>();
  const visit = (node: PhaseSidebarTreeNode): boolean => {
    let descendantMatched = false;
    for (const child of node.children) {
      descendantMatched = visit(child) || descendantMatched;
    }
    if (descendantMatched) forced.add(node.key);
    return descendantMatched || matches(node.row);
  };
  for (const node of nodes) visit(node);
  return forced;
}

/** Indentation in px for a nested row, capped so deep chains stay readable. */
export function phaseSidebarTreeIndent(depth: number): number {
  return Math.min(depth, PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH) * 14;
}

export function phaseSidebarFiltersActive(filters: PhaseSidebarFilters): boolean {
  return (
    filters.repositoryKeys.length > 0 ||
    filters.phaseIds.length > 0 ||
    filters.providerKinds.length > 0 ||
    // T3-CUSTOM(expbkt3): ownership, co-participant and custom group facets.
    filters.participantUserIds.length > 0 ||
    filters.ownedByMe ||
    filters.customGroups.length > 0
  );
}

export interface PhaseSidebarTreeGroup extends PhaseSidebarPhaseDefinition {
  readonly nodes: ReadonlyArray<PhaseSidebarTreeNode>;
}

export interface PhaseSidebarTreeGroupsResult {
  readonly groups: ReadonlyArray<PhaseSidebarTreeGroup>;
  /**
   * Parents the user did not open but that must render open anyway, because a
   * filter matched something inside them. Transient — never written to the
   * expansion store, so clearing the filter restores the user's own state.
   */
  readonly forcedExpansionKeys: ReadonlySet<string>;
}

/**
 * The full pipeline for one section: filter, nest, then group the roots.
 *
 * Filtering runs against the tree rather than the flat row list so a match is
 * never hidden inside a collapsed parent that does not itself match. A row
 * survives when it matches, or when anything in its subtree matches (its
 * ancestors are carried along to keep the path renderable).
 */
export interface PhaseSidebarFilteredTreeInput {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly filters: PhaseSidebarFilters;
  readonly compareSiblings: (left: PhaseSidebarRow, right: PhaseSidebarRow) => number;
  readonly titleForKey?: (key: string) => string | null;
}

export interface PhaseSidebarFilteredTree {
  readonly tree: ReadonlyArray<PhaseSidebarTreeNode>;
  readonly forcedExpansionKeys: ReadonlySet<string>;
}

/**
 * Filter, then nest — the part of the pipeline every grouping mode shares.
 *
 * Filtering runs against the tree rather than the flat row list so a match is
 * never hidden inside a collapsed parent that does not itself match. A row
 * survives when it matches, or when anything in its subtree matches (its
 * ancestors are carried along to keep the path renderable).
 */
export function buildPhaseSidebarFilteredTree(
  input: PhaseSidebarFilteredTreeInput,
): PhaseSidebarFilteredTree {
  const candidates = input.rows.filter((row) => row.thread.archivedAt === null);
  const matches = (row: PhaseSidebarRow) => matchesPhaseSidebarFilters(row, input.filters);
  const filtersActive = phaseSidebarFiltersActive(input.filters);

  let survivingRows = candidates;
  if (filtersActive) {
    // Nest against the UNFILTERED set first, so ancestry is true lineage rather
    // than an artefact of what the filter happened to leave behind. A row is
    // kept when it matches; its ancestors come along to keep the path to it
    // renderable.
    const keep = new Set<string>();
    const visit = (node: PhaseSidebarTreeNode, ancestorKeys: ReadonlyArray<string>): void => {
      if (matches(node.row)) {
        keep.add(node.key);
        for (const ancestorKey of ancestorKeys) keep.add(ancestorKey);
      }
      const nextAncestors = [...ancestorKeys, node.key];
      for (const child of node.children) visit(child, nextAncestors);
    };
    for (const node of buildPhaseSidebarTree(candidates, {
      compareSiblings: input.compareSiblings,
    })) {
      visit(node, []);
    }
    survivingRows = candidates.filter((row) => keep.has(phaseSidebarRowKey(row)));
  }

  // Descendant counts and the busy rollup describe what actually renders.
  const tree = buildPhaseSidebarTree(survivingRows, {
    compareSiblings: input.compareSiblings,
    ...(input.titleForKey ? { titleForKey: input.titleForKey } : {}),
  });

  return {
    tree,
    forcedExpansionKeys: filtersActive
      ? resolveForcedExpansionKeys(tree, matches)
      : new Set<string>(),
  };
}

/** Roots bucketed by lifecycle phase, in the canonical phase order. */
export function groupPhaseSidebarTreeByPhase(
  tree: ReadonlyArray<PhaseSidebarTreeNode>,
): ReadonlyArray<PhaseSidebarTreeGroup> {
  return PHASE_SIDEBAR_PHASES.flatMap((phase) => {
    const nodes = tree.filter((node) => resolvePhaseSidebarTreePhase(node) === phase.id);
    return nodes.length > 0 ? [{ ...phase, nodes }] : [];
  });
}

/** The full pipeline for one section: filter, nest, then group the roots by phase. */
export function buildPhaseSidebarTreeGroups(
  input: PhaseSidebarFilteredTreeInput,
): PhaseSidebarTreeGroupsResult {
  const { tree, forcedExpansionKeys } = buildPhaseSidebarFilteredTree(input);
  return { groups: groupPhaseSidebarTreeByPhase(tree), forcedExpansionKeys };
}
