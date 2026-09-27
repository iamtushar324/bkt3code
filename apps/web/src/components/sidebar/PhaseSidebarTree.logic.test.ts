// T3-CUSTOM(expbkt3): session tree coverage for the experimental sidebar.
import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadShell } from "../../types";
import {
  EMPTY_PHASE_SIDEBAR_FILTERS,
  type PhaseSidebarFilters,
  type PhaseSidebarPhaseId,
  type PhaseSidebarRow,
} from "./PhaseGroupedSidebar.logic";
import {
  buildPhaseSidebarTree,
  buildPhaseSidebarTreeGroups,
  collectPhaseSidebarSubtreeKeys,
  flattenPhaseSidebarTree,
  phaseSidebarRowKey,
  phaseSidebarTreeIndent,
  resolvePhaseSidebarTreePhase,
  PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH,
} from "./PhaseSidebarTree.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const now = "2026-07-16T10:00:00.000Z";

function makeThread(id: string, overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId,
    ownerUserId: null,
    memberUserIds: [],
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    sourceControlProfileId: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as ThreadShell;
}

function makeRow(
  id: string,
  options: {
    readonly parent?: string | null;
    // T3-CUSTOM(expbkt3): the environment the named parent lives on.
    readonly parentEnvironment?: string;
    readonly environment?: string;
    readonly phaseId?: PhaseSidebarPhaseId;
    readonly repositoryKey?: string;
    readonly archived?: boolean;
    readonly pendingApproval?: boolean;
    readonly unread?: boolean;
  } = {},
): PhaseSidebarRow {
  const thread = makeThread(id, {
    ...(options.parent !== undefined
      ? { parentThreadId: options.parent === null ? null : ThreadId.make(options.parent) }
      : {}),
    ...(options.environment !== undefined
      ? { environmentId: EnvironmentId.make(options.environment) }
      : {}),
    ...(options.parentEnvironment !== undefined
      ? { parentEnvironmentId: EnvironmentId.make(options.parentEnvironment) }
      : {}),
    ...(options.archived ? { archivedAt: now } : {}),
    ...(options.pendingApproval ? { hasPendingApprovals: true } : {}),
  });
  return {
    thread,
    phaseId: options.phaseId ?? "ready",
    repositoryKey: options.repositoryKey ?? "repo-1",
    repositoryLabel: options.repositoryKey ?? "repo-one",
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
    changeRequestState: null,
  };
}

const byId = (left: PhaseSidebarRow, right: PhaseSidebarRow) =>
  String(left.thread.id).localeCompare(String(right.thread.id));

const key = (id: string) => phaseSidebarRowKey(makeRow(id));

describe("buildPhaseSidebarTree", () => {
  it("nests a session under the session that spawned it", () => {
    const tree = buildPhaseSidebarTree(
      [makeRow("parent"), makeRow("child", { parent: "parent" })],
      { compareSiblings: byId },
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]?.row.thread.id).toBe("parent");
    expect(tree[0]?.children.map((node) => node.row.thread.id)).toEqual(["child"]);
    expect(tree[0]?.descendantCount).toBe(1);
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it("counts the whole subtree, not just direct children", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root"),
        makeRow("child-a", { parent: "root" }),
        makeRow("child-b", { parent: "root" }),
        makeRow("grandchild", { parent: "child-a" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.descendantCount).toBe(3);
    expect(tree[0]?.children[0]?.descendantCount).toBe(1);
    expect(tree[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it("counts unread and working descendants over the whole subtree", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root", { unread: true }),
        makeRow("child-a", { parent: "root", unread: true }),
        makeRow("child-b", { parent: "root", phaseId: "implementing" }),
        makeRow("grandchild", { parent: "child-a", unread: true, phaseId: "planning" }),
      ],
      { compareSiblings: byId },
    );

    // The root's own unread state is not part of its subtree counters.
    expect(tree[0]?.descendantUnreadCount).toBe(2);
    expect(tree[0]?.descendantRunningCount).toBe(2);
    expect(tree[0]?.children[0]?.descendantUnreadCount).toBe(1);
    expect(tree[0]?.children[0]?.descendantRunningCount).toBe(1);
    expect(tree[0]?.children[1]?.descendantUnreadCount).toBe(0);
    expect(tree[0]?.children[1]?.descendantRunningCount).toBe(0);
  });

  it("reports zero subtree counters for a leaf", () => {
    const tree = buildPhaseSidebarTree(
      [makeRow("solo", { unread: true, phaseId: "implementing" })],
      { compareSiblings: byId },
    );

    expect(tree[0]?.descendantUnreadCount).toBe(0);
    expect(tree[0]?.descendantRunningCount).toBe(0);
  });

  it("promotes a row to the top level when its parent is not in this section", () => {
    // The parent is settled (a different section) — the child must still render.
    const tree = buildPhaseSidebarTree([makeRow("orphan", { parent: "elsewhere" })], {
      compareSiblings: byId,
      titleForKey: (candidate) => (candidate === key("elsewhere") ? "Settled parent" : null),
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.depth).toBe(0);
    expect(tree[0]?.orphanedFrom).toEqual({ key: key("elsewhere"), title: "Settled parent" });
  });

  // T3-CUSTOM(expbkt3): BEGIN — lineage that crosses environments.
  it("nests a session under a parent that lives on another machine", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("remote-parent", { environment: "environment-remote" }),
        makeRow("local-child", {
          parent: "remote-parent",
          parentEnvironment: "environment-remote",
        }),
      ],
      { compareSiblings: byId },
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]?.row.thread.id).toBe("remote-parent");
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.row.thread.id).toBe("local-child");
  });

  it("does not adopt a same-id thread on the wrong environment", () => {
    // Two environments can mint the same thread id; only the named one is the
    // parent, and the other must not swallow the child.
    const tree = buildPhaseSidebarTree(
      [
        makeRow("shared", { environment: "environment-local" }),
        makeRow("child", { parent: "shared", parentEnvironment: "environment-remote" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree).toHaveLength(2);
    expect(tree.map((node) => node.row.thread.id).sort()).toEqual(["child", "shared"]);
  });

  it("still promotes a child whose remote parent is not rendering", () => {
    const tree = buildPhaseSidebarTree(
      [makeRow("child", { parent: "gone", parentEnvironment: "environment-remote" })],
      { compareSiblings: byId },
    );

    expect(tree).toHaveLength(1);
    expect(tree[0]?.depth).toBe(0);
  });
  // T3-CUSTOM(expbkt3): END

  it("leaves no breadcrumb when the parent cannot be named at all", () => {
    const tree = buildPhaseSidebarTree([makeRow("orphan", { parent: "deleted" })], {
      compareSiblings: byId,
    });

    expect(tree[0]?.orphanedFrom).toBeNull();
  });

  it("promotes both rows to roots rather than looping on a corrupt cycle", () => {
    const tree = buildPhaseSidebarTree(
      [makeRow("a", { parent: "b" }), makeRow("b", { parent: "a" })],
      { compareSiblings: byId },
    );

    expect(tree.map((node) => node.row.thread.id).toSorted()).toEqual(["a", "b"]);
    expect(tree.every((node) => node.children.length === 0)).toBe(true);
  });

  it("never treats a self-parented row as its own child", () => {
    const tree = buildPhaseSidebarTree([makeRow("self", { parent: "self" })], {
      compareSiblings: byId,
    });

    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(0);
  });

  it("orders siblings with the same comparator used for roots", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root"),
        makeRow("child-z", { parent: "root" }),
        makeRow("child-a", { parent: "root" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.children.map((node) => node.row.thread.id)).toEqual(["child-a", "child-z"]);
  });
});

describe("resolvePhaseSidebarTreePhase", () => {
  it("pulls a parent into Implementing while any descendant is working", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "implementing" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("implementing");
  });

  it("treats a planning child as working too", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "planning" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("implementing");
  });

  it("rolls up through a grandchild", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root", { phaseId: "ready" }),
        makeRow("mid", { parent: "root", phaseId: "ready" }),
        makeRow("leaf", { parent: "mid", phaseId: "implementing" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("implementing");
  });

  it("hoists a parent into Needs Input when a child is waiting on a human", () => {
    // Reversal of the original rule. In practice a stuck child two levels down
    // under a parent filed as "Implementing" was invisible: nothing surfaced it
    // until someone expanded the right row.
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "implementing" }),
        makeRow("child", { parent: "parent", phaseId: "needs_input" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("needs_input");
    expect(tree[0]?.descendantAttention).toBe("input");
  });

  it("hoists on a pending approval, which never changes a child's own phase", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "implementing", pendingApproval: true }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("needs_input");
    expect(tree[0]?.descendantAttention).toBe("approval");
  });

  it("reports the most blocking descendant when several are stuck", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("waiting", { parent: "parent", phaseId: "needs_input" }),
        makeRow("approving", { parent: "parent", phaseId: "ready", pendingApproval: true }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.descendantAttention).toBe("input");
  });

  it("rolls attention up through a grandchild", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root", { phaseId: "ready" }),
        makeRow("mid", { parent: "root", phaseId: "ready" }),
        makeRow("leaf", { parent: "mid", phaseId: "needs_input" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("needs_input");
  });

  it("prefers attention over work when the subtree has both", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("busy", { parent: "parent", phaseId: "implementing" }),
        makeRow("stuck", { parent: "parent", phaseId: "needs_input" }),
      ],
      { compareSiblings: byId },
    );

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("needs_input");
  });

  // T3-CUSTOM(expbkt3): BEGIN — a plan below a parent is violet, not red.
  it("hoists a plan-only subtree into Plan Ready rather than Needs Input", () => {
    // Turning the parent red for a plan would put a violet reason in the red
    // group and overstate how blocked the subtree is.
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "plan_ready" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.descendantAttention).toBe("plan");
    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("plan_ready");
  });

  it("still goes red when the subtree holds both a plan and a question", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("planning", { parent: "parent", phaseId: "plan_ready" }),
        makeRow("stuck", { parent: "parent", phaseId: "needs_input" }),
      ],
      { compareSiblings: byId },
    );

    expect(tree[0]?.descendantAttention).toBe("input");
    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("needs_input");
  });

  it("hoists an ask-only subtree into Ask, above a plan and below a question", () => {
    const askOnly = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "ask" }),
      ],
      { compareSiblings: byId },
    );
    expect(askOnly[0]?.descendantAttention).toBe("ask");
    expect(resolvePhaseSidebarTreePhase(askOnly[0] as never)).toBe("ask");

    // A question someone asked outranks a plan waiting to be read...
    const askAndPlan = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("planning", { parent: "parent", phaseId: "plan_ready" }),
        makeRow("asking", { parent: "parent", phaseId: "ask" }),
      ],
      { compareSiblings: byId },
    );
    expect(resolvePhaseSidebarTreePhase(askAndPlan[0] as never)).toBe("ask");

    // ...and loses to a parked session.
    const askAndInput = buildPhaseSidebarTree(
      [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("asking", { parent: "parent", phaseId: "ask" }),
        makeRow("stuck", { parent: "parent", phaseId: "needs_input" }),
      ],
      { compareSiblings: byId },
    );
    expect(resolvePhaseSidebarTreePhase(askAndInput[0] as never)).toBe("needs_input");
  });
  // T3-CUSTOM(expbkt3): END

  it("leaves a childless row in its own phase", () => {
    const tree = buildPhaseSidebarTree([makeRow("solo", { phaseId: "plan_ready" })], {
      compareSiblings: byId,
    });

    expect(resolvePhaseSidebarTreePhase(tree[0] as never)).toBe("plan_ready");
  });
});

describe("flattenPhaseSidebarTree", () => {
  const tree = buildPhaseSidebarTree(
    [
      makeRow("root"),
      makeRow("child", { parent: "root" }),
      makeRow("grandchild", { parent: "child" }),
      makeRow("other"),
    ],
    { compareSiblings: byId },
  );

  it("omits collapsed subtrees so keyboard traversal skips hidden rows", () => {
    const flattened = flattenPhaseSidebarTree(tree, () => false);

    expect(flattened.map((node) => node.row.thread.id)).toEqual(["other", "root"]);
  });

  it("walks an expanded subtree in render order", () => {
    const flattened = flattenPhaseSidebarTree(tree, () => true);

    expect(flattened.map((node) => node.row.thread.id)).toEqual([
      "other",
      "root",
      "child",
      "grandchild",
    ]);
  });

  it("stops descending at the first collapsed ancestor", () => {
    const flattened = flattenPhaseSidebarTree(tree, (candidate) => candidate === key("root"));

    expect(flattened.map((node) => node.row.thread.id)).toEqual(["other", "root", "child"]);
  });
});

describe("buildPhaseSidebarTreeGroups", () => {
  const filtersFor = (overrides: Partial<PhaseSidebarFilters>): PhaseSidebarFilters => ({
    ...EMPTY_PHASE_SIDEBAR_FILTERS,
    ...overrides,
  });

  it("groups a parent by its rolled-up phase, keeping children nested", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [
        makeRow("parent", { phaseId: "ready" }),
        makeRow("child", { parent: "parent", phaseId: "implementing" }),
      ],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(groups.map((group) => group.id)).toEqual(["implementing"]);
    expect(groups[0]?.nodes).toHaveLength(1);
    expect(groups[0]?.nodes[0]?.children).toHaveLength(1);
  });

  it("drops archived rows before nesting", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [makeRow("parent"), makeRow("child", { parent: "parent", archived: true })],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(groups[0]?.nodes[0]?.descendantCount).toBe(0);
  });

  it("keeps a non-matching parent so a matching child stays reachable", () => {
    const { groups, forcedExpansionKeys } = buildPhaseSidebarTreeGroups({
      rows: [
        makeRow("parent", { repositoryKey: "repo-a" }),
        makeRow("child", { parent: "parent", repositoryKey: "repo-b" }),
      ],
      filters: filtersFor({ repositoryKeys: ["repo-b"] }),
      compareSiblings: byId,
    });

    const roots = groups.flatMap((group) => group.nodes);
    expect(roots.map((node) => node.row.thread.id)).toEqual(["parent"]);
    expect(roots[0]?.children.map((node) => node.row.thread.id)).toEqual(["child"]);
    // The cross-repo match must not stay hidden inside a collapsed parent.
    expect(forcedExpansionKeys.has(key("parent"))).toBe(true);
  });

  it("recomputes the child count over what survives the filter", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [
        makeRow("parent", { repositoryKey: "repo-a" }),
        makeRow("kept", { parent: "parent", repositoryKey: "repo-b" }),
        makeRow("dropped", { parent: "parent", repositoryKey: "repo-c" }),
      ],
      filters: filtersFor({ repositoryKeys: ["repo-b"] }),
      compareSiblings: byId,
    });

    expect(groups.flatMap((group) => group.nodes)[0]?.descendantCount).toBe(1);
  });

  it("forces no expansion when no filter is active", () => {
    const { forcedExpansionKeys } = buildPhaseSidebarTreeGroups({
      rows: [makeRow("parent"), makeRow("child", { parent: "parent" })],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(forcedExpansionKeys.size).toBe(0);
  });

  it("omits phases with no roots", () => {
    const { groups } = buildPhaseSidebarTreeGroups({
      rows: [makeRow("solo", { phaseId: "ready" })],
      filters: EMPTY_PHASE_SIDEBAR_FILTERS,
      compareSiblings: byId,
    });

    expect(groups.map((group) => group.id)).toEqual(["ready"]);
  });
});

describe("collectPhaseSidebarSubtreeKeys", () => {
  it("returns every descendant key and never the root itself", () => {
    const tree = buildPhaseSidebarTree(
      [
        makeRow("root"),
        makeRow("child", { parent: "root" }),
        makeRow("grandchild", { parent: "child" }),
      ],
      { compareSiblings: byId },
    );

    expect(collectPhaseSidebarSubtreeKeys(tree[0] as never).toSorted()).toEqual(
      [key("child"), key("grandchild")].toSorted(),
    );
  });
});

describe("phaseSidebarTreeIndent", () => {
  it("grows with depth and then stops so deep chains keep their titles", () => {
    expect(phaseSidebarTreeIndent(0)).toBe(0);
    expect(phaseSidebarTreeIndent(1)).toBeGreaterThan(phaseSidebarTreeIndent(0));
    expect(phaseSidebarTreeIndent(9)).toBe(
      phaseSidebarTreeIndent(PHASE_SIDEBAR_TREE_MAX_INDENT_DEPTH),
    );
  });
});
