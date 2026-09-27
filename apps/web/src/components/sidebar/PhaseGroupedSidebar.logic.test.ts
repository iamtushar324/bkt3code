import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  UserId,
  type OrchestrationSessionStatus,
  type VcsStatusResult,
} from "@t3tools/contracts";
// T3-CUSTOM(expbkt3): worktree codenames.
import {
  resolveWorktreeCodename,
  worktreeCodenameToneIndex,
} from "@t3tools/shared/worktreeCodename";
import { describe, expect, it } from "vite-plus/test";

import type { Project, ThreadShell } from "../../types";
import {
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  PHASE_SIDEBAR_PHASE_IDS,
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarGroups,
  buildPhaseSidebarRepositoryOptions,
  derivePhaseSidebarRepositoryKey,
  isThreadAssignedToUser,
  phaseSidebarThreadParticipantIds,
  // T3-CUSTOM(expbkt3): owner avatar on rows someone else started.
  phaseSidebarRowOwnerAvatarUserId,
  filterVisiblePhaseSidebarRows,
  matchesPhaseSidebarFilters,
  partitionPhaseSidebarRows,
  phaseSidebarGroupHeaderClassName,
  phaseSidebarPriorityBadgeClassName,
  phaseSidebarCanForceStopAgent,
  phaseSidebarRowActionsClassName,
  phaseSidebarRowClassName,
  phaseSidebarNeedsUserInput,
  phaseSidebarPriorityRank,
  formatThreadPriority,
  compactPhaseSidebarTimeLabel,
  reconcilePhaseSidebarFilters,
  resolvePhaseSidebarAttentionKind,
  resolvePhaseSidebarCheckoutMetadata,
  // T3-CUSTOM(expbkt3): PR badge in the row metadata lane.
  resolvePhaseSidebarChangeRequestBadge,
  // T3-CUSTOM(expbkt3): worktree codenames.
  resolvePhaseSidebarWorktreeView,
  phaseSidebarWorktreeRowProps,
  resolvePhaseSidebarDisplayPhase,
  resolvePhaseSidebarLinearIssue,
  resolvePhaseSidebarPhase,
  resolvePhaseSidebarProviderCode,
  resolvePhaseSidebarTraversalTarget,
  resolvePhaseSidebarWorkBadge,
  sanitizePhaseSidebarFilters,
  sanitizePhaseSidebarSort,
  type PhaseSidebarRow,
} from "./PhaseGroupedSidebar.logic";

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-07-16T10:00:00.000Z";

describe("phaseSidebarRowClassName", () => {
  it("gives the routed row a primary surface strong enough to spot at a glance", () => {
    const className = phaseSidebarRowClassName(true, false, false);

    expect(className).toContain("bg-primary/18");
    expect(className).toContain("ring-primary/45");
    expect(className).toContain("font-semibold");
  });

  it("keeps multi-selection distinct and strengthens the routed selected row", () => {
    const selected = phaseSidebarRowClassName(false, true, false);
    const activeSelected = phaseSidebarRowClassName(true, true, false);

    expect(selected).toContain("bg-primary/18");
    expect(selected).not.toContain("ring-primary/55");
    expect(activeSelected).toContain("bg-primary/26");
    expect(activeSelected).toContain("ring-primary/55");
  });

  it("preserves the urgent input treatment on an active row", () => {
    const className = phaseSidebarRowClassName(true, false, true);

    expect(className).toContain("bg-red-500/20");
    expect(className).toContain("ring-red-500/60");
    expect(className).toContain("motion-reduce:animate-none");
  });

  it("tints only the routed row, and never by priority", () => {
    const active = phaseSidebarRowClassName(true, false, false);
    const idle = phaseSidebarRowClassName(false, false, false);

    expect(active).toContain("bg-primary/18");
    expect(active).toContain("ring-primary/45");
    // Priority is the badge's job now: no row surface reads as orange.
    expect(active).not.toContain("orange");
    expect(idle).not.toContain("orange");
    expect(idle).not.toContain("bg-primary");
  });

  it("vertically centers the adaptive content lane", () => {
    const className = phaseSidebarRowClassName(false, false, false);

    expect(className).toContain("items-center");
    expect(className).not.toContain("items-start");
  });
});

describe("phaseSidebarRowActionsClassName", () => {
  it("unpins closed row actions without losing hover or keyboard visibility", () => {
    const closed = phaseSidebarRowActionsClassName(false).split(/\s+/);
    const open = phaseSidebarRowActionsClassName(true).split(/\s+/);
    const closedAgain = phaseSidebarRowActionsClassName(false).split(/\s+/);

    expect(closed).toContain("hidden");
    expect(closed).not.toContain("flex");
    expect(closed).toContain("group-hover/phase-row:flex");
    expect(closed).toContain("group-focus-visible/phase-row:flex");
    expect(closed).toContain("group-has-[:focus-visible]/phase-row:flex");
    expect(closed).not.toContain("group-focus-within/phase-row:flex");
    expect(open).toContain("flex");
    expect(closedAgain).toEqual(closed);
  });
});

// T3-CUSTOM(expbkt3): BEGIN — the violet Plan Ready row treatment.
describe("phase sidebar plan-ready rows", () => {
  it("mirrors the Needs Input pulse in violet", () => {
    const planReady = phaseSidebarRowClassName(false, false, false, true);

    expect(planReady).toContain("animate-[pulse_1.25s_ease-in-out_infinite]");
    expect(planReady).toContain("bg-violet-500/20");
    expect(planReady).toContain("ring-violet-500/60");
    expect(planReady).toContain("shadow-[inset_3px_0_0_0_var(--color-violet-500)");
    expect(planReady).toContain("motion-reduce:animate-none");
  });

  it("stays visually distinct from the red Needs Input row", () => {
    const planReady = phaseSidebarRowClassName(false, false, false, true);
    const needsInput = phaseSidebarRowClassName(false, false, true, false);

    expect(planReady).not.toContain("bg-red-500/20");
    expect(needsInput).not.toContain("bg-violet-500/20");
    expect(planReady).not.toBe(needsInput);
  });

  it("lets a question win the row when a plan is also waiting", () => {
    // Both flags can be true mid-transition; the row must not carry two pulses.
    const both = phaseSidebarRowClassName(false, false, true, true);

    expect(both).toContain("bg-red-500/20");
    expect(both).not.toContain("bg-violet-500/20");
  });

  it("leaves an ordinary row unpulsed", () => {
    expect(phaseSidebarRowClassName(false, false, false, false)).not.toContain(
      "animate-[pulse_1.25s_ease-in-out_infinite]",
    );
  });
});
// T3-CUSTOM(expbkt3): END

describe("phase sidebar group headers", () => {
  it("gives ready states distinct, theme-aware surfaces and larger labels", () => {
    const planReady = phaseSidebarGroupHeaderClassName("plan_ready");
    const ready = phaseSidebarGroupHeaderClassName("ready");

    expect(planReady).toContain("bg-violet-500/9");
    expect(planReady).toContain("dark:bg-violet-400/9");
    expect(ready).toContain("bg-emerald-500/7");
    expect(planReady).not.toBe(ready);
  });
});

describe("phase sidebar work badge", () => {
  it("keeps a foreground Running label even when subagents are live", () => {
    expect(
      resolvePhaseSidebarWorkBadge({
        phaseId: "implementing",
        backgroundLiveness: "working",
        executionPresentation: { active: true, label: "Running" },
      }),
    ).toEqual({ label: "Running", monitoring: false });
  });

  it("distinguishes background agent work from monitor loops after the turn settles", () => {
    expect(
      resolvePhaseSidebarWorkBadge({
        phaseId: "implementing",
        backgroundLiveness: "working",
        executionPresentation: { active: false, label: null },
      }),
    ).toEqual({ label: "Working", monitoring: false });

    expect(
      resolvePhaseSidebarWorkBadge({
        phaseId: "implementing",
        backgroundLiveness: "monitoring",
        executionPresentation: { active: false, label: null },
      }),
    ).toEqual({ label: "Monitoring", monitoring: true });
  });

  it("lets actionable Plan Ready suppress lingering background status", () => {
    expect(
      resolvePhaseSidebarWorkBadge({
        phaseId: "plan_ready",
        backgroundLiveness: "working",
        executionPresentation: { active: false, label: null },
      }),
    ).toBeNull();
  });

  it("preserves transitional labels without calling them monitoring", () => {
    expect(
      resolvePhaseSidebarWorkBadge({
        phaseId: "implementing",
        backgroundLiveness: null,
        executionPresentation: { active: true, label: "Stopping" },
      }),
    ).toEqual({ label: "Stopping", monitoring: false });
  });
});

describe("phase sidebar running controls", () => {
  it("keeps force stop available for a recorded session even when it looks stopped", () => {
    const stoppedSession = {
      threadId,
      status: "stopped" as const,
      providerName: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: null,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    };

    expect(phaseSidebarCanForceStopAgent(stoppedSession)).toBe(true);
    expect(phaseSidebarCanForceStopAgent(null)).toBe(false);
  });
});

describe("resolvePhaseSidebarCheckoutMetadata", () => {
  it("shows the live branch for a current checkout", () => {
    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: "stale-branch", worktreePath: null },
        { refName: "dev", baseRef: "main", pr: null },
      ),
    ).toEqual({
      kind: "current",
      label: "dev",
      // T3-CUSTOM(expbkt3): the thread is on `stale-branch` but `dev` is checked
      // out, so the row now says so instead of reading as healthy.
      tooltip: "Current checkout on dev — this thread is on stale-branch",
      toneIndex: null,
      branchMismatch: "stale-branch",
    });
  });

  // T3-CUSTOM(expbkt3): BEGIN — worktree codenames.
  it("names the worktree instead of restating its kind", () => {
    const worktreePath = "/repo/worktrees/t3code-2d633e64";
    const codename = resolveWorktreeCodename(worktreePath);

    const metadata = resolvePhaseSidebarCheckoutMetadata(
      { branch: "t3code/generated-feature", worktreePath },
      { refName: "t3code/generated-feature", baseRef: "main", pr: null },
    );

    expect(metadata.kind).toBe("worktree");
    expect(metadata.label).toBe(codename);
    expect(metadata.label).not.toBe("Worktree");
    expect(metadata.toneIndex).toBe(worktreeCodenameToneIndex(codename));
  });

  it("keeps the starting ref and the path in the tooltip", () => {
    const worktreePath = "/repo/worktrees/t3code-2d633e64";

    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: "t3code/generated-feature", worktreePath },
        { refName: "t3code/generated-feature", baseRef: "main", pr: null },
      ).tooltip,
      // T3-CUSTOM(expbkt3): the codename replaces the branch in the label, so
      // the branch has to survive here.
    ).toBe(
      `Worktree ${resolveWorktreeCodename(worktreePath)} · t3code/generated-feature · from main · ${worktreePath}`,
    );
  });

  it("prefers a pull request base when one is available", () => {
    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: "feature/pr", worktreePath: "/repo/worktrees/pr" },
        {
          refName: "feature/pr",
          baseRef: "main",
          pr: {
            number: 42,
            title: "Feature",
            url: "https://example.com/pr/42",
            baseRef: "release",
            headRef: "feature/pr",
            state: "open",
          },
        },
      ).tooltip,
    ).toContain("from release");
  });

  it("marks a shared worktree on the label and names the occupants", () => {
    const worktreePath = "/repo/worktrees/t3code-2d633e64";
    const codename = resolveWorktreeCodename(worktreePath);

    const metadata = resolvePhaseSidebarCheckoutMetadata(
      { branch: "t3code/generated-feature", worktreePath },
      { refName: "t3code/generated-feature", baseRef: null, pr: null },
      { sharing: { count: 2, summary: "Fix login, Refactor auth" } },
    );

    expect(metadata.label).toBe(`${codename} ×2`);
    expect(metadata.tooltip).toContain("Shared by 2 threads: Fix login, Refactor auth");
  });

  it("uses the view's disambiguated codename when one is supplied", () => {
    expect(
      resolvePhaseSidebarCheckoutMetadata(
        { branch: null, worktreePath: "/repo/worktrees/t3code-2d633e64" },
        null,
        { codename: "lisbon·a4" },
      ).label,
    ).toBe("lisbon·a4");
  });
  // T3-CUSTOM(expbkt3): END
});

// T3-CUSTOM(expbkt3): BEGIN — PR badge beside the Linear tag.
describe("resolvePhaseSidebarChangeRequestBadge", () => {
  const pr = {
    number: 76,
    title: "Name worktrees after cities",
    url: "https://github.com/beknown-work/bkt3code/pull/76",
    baseRef: "bkmain",
    headRef: "t3code/cities",
  } as const;

  it("labels the badge with the number alone and carries state in the colour", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: { ...pr, state: "open" } });

    expect(badge?.label).toBe("#76");
    // The number is the whole label: no state word rides along with it.
    expect(badge?.label).not.toContain("open");
    expect(badge?.colorClassName).toContain("emerald");
  });

  it("gives each state its own hue, matching the thread header's PR indicator", () => {
    const tone = (state: "open" | "merged" | "closed") =>
      resolvePhaseSidebarChangeRequestBadge({ pr: { ...pr, state } })?.colorClassName ?? "";

    expect(tone("open")).toContain("emerald");
    expect(tone("merged")).toContain("violet");
    expect(tone("closed")).toContain("red");
    expect(new Set([tone("open"), tone("merged"), tone("closed")]).size).toBe(3);
  });

  it("keeps the words in the tooltip: state, open-PR modifiers, and the title", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({
      pr: {
        ...pr,
        state: "open",
        isDraft: true,
        checksStatus: "fail",
        reviewDecision: "changes-requested",
      },
    });

    expect(badge?.statusText).toBe("open · draft · changes requested · checks failing");
    expect(badge?.tooltip).toBe(`PR #76 — ${badge?.statusText} · ${pr.title}`);
  });

  it("uses the provider's own term for a change request", () => {
    expect(
      resolvePhaseSidebarChangeRequestBadge({
        pr: { ...pr, state: "merged" },
        sourceControlProvider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" },
      })?.tooltip,
    ).toContain("MR #76");
  });

  it("renders nothing without a probed change request", () => {
    expect(resolvePhaseSidebarChangeRequestBadge(null)).toBeNull();
    expect(resolvePhaseSidebarChangeRequestBadge({ pr: null })).toBeNull();
  });

  const link = (
    number: number,
    overrides: {
      readonly state?: "open" | "closed" | "merged";
      readonly headBranch?: string;
      readonly baseBranch?: string;
      readonly isDraft?: boolean;
      readonly synced?: boolean;
    } = {},
  ) => ({
    host: "github.com",
    repository: "beknown-work/bkt3code",
    number,
    url: `https://github.com/beknown-work/bkt3code/pull/${number}`,
    source: "agent" as const,
    linkedAt: "2026-09-15T10:00:00.000Z",
    stack: null,
    snapshot:
      overrides.synced === false
        ? null
        : {
            state: overrides.state ?? "open",
            title: `PR ${number}`,
            headBranch: overrides.headBranch ?? `t3code/branch-${number}`,
            baseBranch: overrides.baseBranch ?? "expbkmain",
            isDraft: overrides.isDraft ?? false,
            updatedAt: null,
            syncedAt: "2026-09-15T10:00:00.000Z",
          },
  });

  it("shows a review an agent tagged even when the branch probe found nothing", () => {
    // `link_pull_request` is the only way a PR in another repository, or one
    // opened before the branch existed, ever reaches this row.
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: null }, [link(76)]);

    expect(badge?.label).toBe("#76");
    expect(badge?.kind).toBe("single");
    expect(badge?.url).toBe("https://github.com/beknown-work/bkt3code/pull/76");
  });

  it("prefers tagged links over the branch probe", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: { ...pr, state: "open" } }, [
      link(99),
    ]);

    expect(badge?.label).toBe("#99");
  });

  it("keeps the number visible and counts the rest when several are tagged", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: null }, [
      link(10, { state: "merged" }),
      link(20),
    ]);

    expect(badge?.label).toMatch(/^#\d+ \+1$/u);
    expect(badge?.kind).toBe("multiple");
    expect(badge?.entries.map((entry) => entry.label).sort()).toEqual(["#10", "#20"]);
  });

  it("calls one chain a stack, so the row can wear a different glyph", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: null }, [
      link(1, { headBranch: "layer-1", baseBranch: "expbkmain" }),
      link(2, { headBranch: "layer-2", baseBranch: "layer-1" }),
      link(3, { headBranch: "layer-3", baseBranch: "layer-2" }),
    ]);

    expect(badge?.kind).toBe("stack");
    expect(badge?.entries).toHaveLength(3);
    // Bottom of the stack first, so the list reads the way the stack merges.
    expect(badge?.entries.map((entry) => entry.label)).toEqual(["#1", "#2", "#3"]);
  });

  it("carries each tagged review's own state, not just the aggregate", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: null }, [
      link(10, { state: "merged" }),
      link(20, { state: "open" }),
    ]);
    const tones = new Map(badge?.entries.map((entry) => [entry.label, entry.colorClassName]));

    expect(tones.get("#10")).toContain("violet");
    expect(tones.get("#20")).toContain("emerald");
  });

  it("keeps the lane to three hues: a draft is an open review wearing a modifier", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: null }, [
      link(10, { isDraft: true }),
      link(20, { isDraft: true }),
    ]);

    expect(badge?.state).toBe("open");
    expect(badge?.colorClassName).toContain("emerald");
  });

  it("says a freshly tagged review is not synced rather than inventing a state", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge({ pr: null }, [
      link(76, { synced: false }),
    ]);

    expect(badge?.statusText).toBe("not synced yet");
    expect(badge?.entries[0]?.title).toBeNull();
  });

  it("falls back to the branch probe when nothing is tagged", () => {
    expect(resolvePhaseSidebarChangeRequestBadge({ pr: { ...pr, state: "open" } }, [])?.label).toBe(
      "#76",
    );
  });

  it("says nothing about draft or checks once the PR is merged", () => {
    // Those modifiers only describe an open PR; repeating them after the merge
    // would read as unfinished work.
    expect(
      resolvePhaseSidebarChangeRequestBadge({
        pr: { ...pr, state: "merged", isDraft: true, checksStatus: "fail" },
      })?.statusText,
    ).toBe("merged");
  });
});
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN — shared-worktree awareness.
describe("resolvePhaseSidebarWorktreeView", () => {
  function thread(title: string, worktreePath: string | null, archivedAt: string | null = null) {
    return { title, worktreePath, archivedAt };
  }

  it("reports no sharing when every thread has its own worktree", () => {
    const view = resolvePhaseSidebarWorktreeView([
      thread("A", "/w/one"),
      thread("B", "/w/two"),
      thread("C", null),
    ]);

    expect(view.sharingByPath.size).toBe(0);
    expect(view.codenameByPath.get("/w/one")).toBe(resolveWorktreeCodename("/w/one"));
  });

  it("counts and names the threads occupying one worktree", () => {
    const view = resolvePhaseSidebarWorktreeView([
      thread("Fix login", "/w/shared"),
      thread("Refactor auth", "/w/shared"),
      thread("Elsewhere", "/w/other"),
    ]);

    expect(view.sharingByPath.get("/w/shared")).toEqual({
      count: 2,
      summary: "Fix login, Refactor auth",
    });
    expect(view.sharingByPath.has("/w/other")).toBe(false);
  });

  it("does not let archived threads inflate a worktree's occupancy", () => {
    const view = resolvePhaseSidebarWorktreeView([
      thread("Live", "/w/shared"),
      thread("Archived", "/w/shared", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(view.sharingByPath.size).toBe(0);
  });
});

describe("phaseSidebarWorktreeRowProps", () => {
  it("flattens to primitives so the memo'd row compares by value", () => {
    const view = resolvePhaseSidebarWorktreeView([
      { title: "A", worktreePath: "/w/shared", archivedAt: null },
      { title: "B", worktreePath: "/w/shared", archivedAt: null },
    ]);

    const props = phaseSidebarWorktreeRowProps(view, "/w/shared");
    expect(props).toEqual({
      worktreeCodename: resolveWorktreeCodename("/w/shared"),
      worktreeSharedCount: 2,
      worktreeSharedSummary: "A, B",
    });
    // Same inputs, equal values — this is what keeps the memo intact.
    expect(phaseSidebarWorktreeRowProps(view, "/w/shared")).toEqual(props);
  });

  it("still names a worktree the view never saw, such as an archived thread's", () => {
    const view = resolvePhaseSidebarWorktreeView([]);
    expect(phaseSidebarWorktreeRowProps(view, "/w/gone")).toEqual({
      worktreeCodename: resolveWorktreeCodename("/w/gone"),
      worktreeSharedCount: 0,
      worktreeSharedSummary: null,
    });
  });

  it("reports nothing for a thread without a worktree", () => {
    expect(phaseSidebarWorktreeRowProps(resolvePhaseSidebarWorktreeView([]), null)).toEqual({
      worktreeCodename: null,
      worktreeSharedCount: 0,
      worktreeSharedSummary: null,
    });
  });
});
// T3-CUSTOM(expbkt3): END

function makeSession(status: OrchestrationSessionStatus): NonNullable<ThreadShell["session"]> {
  return {
    threadId,
    status,
    providerName: "codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    activeTurnId: status === "running" ? TurnId.make("turn-1") : null,
    lastError: status === "error" ? "Provider crashed" : null,
    updatedAt: now,
  };
}

function makeThread(overrides: Partial<ThreadShell> = {}): ThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
    ownerUserId: null,
    memberUserIds: [],
    title: "Thread",
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
    pullRequests: [],
    ...overrides,
  };
}

function makeRow(overrides: Partial<PhaseSidebarRow> = {}): PhaseSidebarRow {
  const thread = overrides.thread ?? makeThread();
  return {
    thread,
    phaseId: overrides.phaseId ?? resolvePhaseSidebarPhase(thread),
    repositoryKey: "repo-1",
    repositoryLabel: "repo-one",
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    isOwnedByMe: false,
    participantUserIds: [],
    attentionPriority: 5,
    isUnreadCompletion: false,
    // Settlement and snooze default ON: most cases exercise the partition,
    // and the capability-gating cases opt out explicitly.
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    changeRequestState: null,
    ...overrides,
  };
}

describe("phase sidebar lifecycle", () => {
  it("keeps active execution in agent-work groups except urgent structured questions", () => {
    const settledTurn = {
      turnId: TurnId.make("turn-1"),
      state: "completed" as const,
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
      durationMs: null,
    };

    expect(resolvePhaseSidebarPhase(makeThread({ session: makeSession("running") }))).toBe(
      "implementing",
    );
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          session: makeSession("starting"),
        }),
      ),
    ).toBe("planning");
    expect(
      resolvePhaseSidebarPhase(makeThread({ session: makeSession("running") }), {
        pr: {
          number: 1,
          title: "Review",
          url: "https://github.com/acme/repo/pull/1",
          baseRef: "main",
          headRef: "feature/work",
          state: "open",
          autoMergeEnabled: true,
        },
      } as VcsStatusResult),
    ).toBe("implementing");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          latestTurn: settledTurn,
          hasActionableProposedPlan: true,
        }),
      ),
    ).toBe("plan_ready");
    // T3-CUSTOM(expbkt3): plan mode alone is not Plan Ready any more — the group
    // means a plan is waiting for a decision, so an idle plan-mode thread with
    // nothing to decide is just idle.
    expect(resolvePhaseSidebarPhase(makeThread({ interactionMode: "plan" }))).toBe("ready");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          session: makeSession("running"),
          hasPendingUserInput: true,
        }),
      ),
    ).toBe("needs_input");
  });

  it("keeps server-projected background work in agent-work groups after the turn settles", () => {
    expect(resolvePhaseSidebarPhase(makeThread({ backgroundLiveness: "working" }))).toBe(
      "implementing",
    );
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          backgroundLiveness: "monitoring",
        }),
      ),
    ).toBe("planning");
  });

  it("lets failures and actionable plans outrank lingering background liveness", () => {
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          session: makeSession("error"),
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("ready");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("plan_ready");
  });

  it("promotes durable and live pending questions to the first lifecycle group", () => {
    const durableInput = makeThread({
      id: ThreadId.make("thread-durable-input"),
      hasPendingUserInput: true,
    });
    const liveInput = makeThread({
      id: ThreadId.make("thread-live-input"),
      session: makeSession("running"),
      hasPendingUserInput: true,
    });
    const ready = makeThread({ id: ThreadId.make("thread-ready") });

    expect(phaseSidebarNeedsUserInput(durableInput)).toBe(true);
    expect(phaseSidebarNeedsUserInput(liveInput)).toBe(true);
    expect(phaseSidebarNeedsUserInput(ready)).toBe(false);

    const groups = buildPhaseSidebarGroups(
      [
        makeRow({ thread: ready }),
        makeRow({ thread: liveInput }),
        makeRow({ thread: durableInput }),
      ],
      EMPTY_PHASE_SIDEBAR_FILTERS,
      "updated_at",
    );
    expect(groups[0]?.id).toBe("needs_input");
    expect(groups[0]?.rows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-durable-input"),
      ThreadId.make("thread-live-input"),
    ]);
  });

  // T3-CUSTOM(expbkt3): BEGIN — Plan Ready means a plan is waiting, in any mode.
  it("files a plan submitted from a default-mode turn under Plan Ready", () => {
    // `t3_submit_plan` never changes interactionMode, so gating the group on
    // plan mode hid every plan an agent submitted mid-turn.
    expect(
      resolvePhaseSidebarPhase(
        makeThread({ interactionMode: "default", hasActionableProposedPlan: true }),
      ),
    ).toBe("plan_ready");
  });

  it("keeps a waiting plan out of Plan Ready while the agent is still running", () => {
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "default",
          hasActionableProposedPlan: true,
          session: makeSession("running"),
        }),
      ),
    ).toBe("implementing");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          session: makeSession("running"),
        }),
      ),
    ).toBe("planning");
  });

  it("drops a failed thread with nothing to decide into Ready", () => {
    // It used to land in Plan Ready purely for being in plan mode; the ERROR
    // badge already says what happened.
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          session: makeSession("error"),
        }),
      ),
    ).toBe("ready");
  });

  it("keeps a failed thread in Plan Ready when its plan is still outstanding", () => {
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          interactionMode: "plan",
          hasActionableProposedPlan: true,
          session: makeSession("error"),
        }),
      ),
    ).toBe("plan_ready");
  });
  // T3-CUSTOM(expbkt3): END

  it("uses an actionable plan and working state for lifecycle classification", () => {
    // T3-CUSTOM(expbkt3): interaction mode picks Planning vs Implementing while
    // work runs; it no longer decides Plan Ready on its own.
    expect(resolvePhaseSidebarPhase(makeThread({ interactionMode: "plan" }))).toBe("ready");
    expect(resolvePhaseSidebarPhase(makeThread({ interactionMode: "default" }))).toBe("ready");
    expect(
      resolvePhaseSidebarPhase(
        makeThread({ interactionMode: "plan", session: makeSession("running") }),
      ),
    ).toBe("planning");
    expect(resolvePhaseSidebarPhase(makeThread({ session: makeSession("running") }))).toBe(
      "implementing",
    );
  });

  it("puts non-running lifecycle groups before agent work and sorts by thread id on ties", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-a"), archivedAt: now }),
        phaseId: "plan_ready",
      }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-a") }), phaseId: "ready" }),
      makeRow({ thread: makeThread({ id: ThreadId.make("thread-b") }), phaseId: "ready" }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-c") }),
        phaseId: "implementing",
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.map((group) => group.id)).toEqual(["ready", "implementing"]);
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-a"),
      ThreadId.make("thread-b"),
      ThreadId.make("thread-c"),
    ]);
    // T3-CUSTOM(expbkt3): the lifecycle order itself is the contract — Ask sits
    // between the two other groups that wait on a human.
    expect(PHASE_SIDEBAR_PHASE_IDS).toEqual([
      "needs_input",
      "ask",
      "plan_ready",
      "ready",
      "planning",
      "implementing",
    ]);
  });

  // T3-CUSTOM(expbkt3): BEGIN — async questions get their own lifecycle group.
  it("files an async question under ask, below a parked session and above a plan", () => {
    // The agent asked and kept working: grouping by liveness alone would file
    // this under Implementing, where nobody would see the question.
    expect(
      resolvePhaseSidebarPhase(
        makeThread({ session: makeSession("running"), hasPendingAsyncUserInput: true }),
      ),
    ).toBe("ask");
    expect(resolvePhaseSidebarPhase(makeThread({ hasPendingAsyncUserInput: true }))).toBe("ask");
    // A parked session still outranks it.
    expect(
      resolvePhaseSidebarPhase(
        makeThread({ hasPendingAsyncUserInput: true, hasPendingUserInput: true }),
      ),
    ).toBe("needs_input");
    // A question someone asked outranks a plan waiting to be read.
    expect(
      resolvePhaseSidebarPhase(
        makeThread({
          hasPendingAsyncUserInput: true,
          hasActionableProposedPlan: true,
        }),
      ),
    ).toBe("ask");
  });

  it("keeps the plan attention kind when a thread holds a plan and a question", () => {
    // The row renders ASK from the thread and PLAN from the attention kind, so
    // this deliberately stays "plan": both badges have to survive together.
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ hasActionableProposedPlan: true, hasPendingAsyncUserInput: true }),
      ),
    ).toBe("plan");
    expect(resolvePhaseSidebarAttentionKind(makeThread({ hasPendingAsyncUserInput: true }))).toBe(
      "ask",
    );
    // Blocking kinds still win the badge outright.
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ hasPendingUserInput: true, hasPendingAsyncUserInput: true }),
      ),
    ).toBe("input");
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ hasPendingApprovals: true, hasPendingAsyncUserInput: true }),
      ),
    ).toBe("approval");
  });

  it("ranks the row highlight red over amber over violet", () => {
    const ask = phaseSidebarRowClassName(false, false, false, false, true);
    expect(ask).toContain("bg-amber-500/20");
    // A question outranks a plan: only one pulse ever runs on a row.
    const askAndPlan = phaseSidebarRowClassName(false, false, false, true, true);
    expect(askAndPlan).toContain("bg-amber-500/20");
    expect(askAndPlan).not.toContain("bg-violet-500/20");
    // A parked session outranks both.
    const inputAndAsk = phaseSidebarRowClassName(false, false, true, false, true);
    expect(inputAndAsk).toContain("bg-red-500/20");
    expect(inputAndAsk).not.toContain("bg-amber-500/20");
  });

  it("keeps the work badge on an ask row, unlike plan ready", () => {
    // The agent is still running, so the row has to keep saying so.
    expect(
      resolvePhaseSidebarWorkBadge({
        phaseId: "ask",
        backgroundLiveness: "working",
        executionPresentation: { active: true, label: "Running" },
      }),
    ).toEqual({ label: "Running", monitoring: false });
  });
  // T3-CUSTOM(expbkt3): END

  it("uses ready only as the non-running fallback", () => {
    expect(resolvePhaseSidebarPhase(makeThread())).toBe("ready");
    expect(resolvePhaseSidebarPhase(makeThread({ session: makeSession("running") }))).not.toBe(
      "ready",
    );
    expect(resolvePhaseSidebarPhase(makeThread({ session: null }))).toBe("ready");
  });

  it("does not invent a reconnect-only lifecycle group", () => {
    expect(resolvePhaseSidebarDisplayPhase("ready", "implementing")).toBe("ready");
  });
});

describe("phase sidebar attention badges", () => {
  it("prioritizes structured input over approval and error", () => {
    const thread = makeThread({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      session: makeSession("error"),
    });

    expect(resolvePhaseSidebarAttentionKind(thread)).toBe("input");
  });

  it("recognizes durable and live approval requests", () => {
    expect(resolvePhaseSidebarAttentionKind(makeThread({ hasPendingApprovals: true }))).toBe(
      "approval",
    );
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ session: makeSession("running"), hasPendingApprovals: true }),
      ),
    ).toBe("approval");
  });

  it("recognizes failed execution after user-blocking states", () => {
    expect(resolvePhaseSidebarAttentionKind(makeThread({ session: makeSession("error") }))).toBe(
      "error",
    );
  });

  // T3-CUSTOM(expbkt3): BEGIN — a plan waiting on a human is attention too.
  it("reports a waiting plan as attention, ranked below every blocking kind", () => {
    expect(resolvePhaseSidebarAttentionKind(makeThread({ hasActionableProposedPlan: true }))).toBe(
      "plan",
    );
    // A question, an approval and a failure each outrank it.
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ hasActionableProposedPlan: true, hasPendingUserInput: true }),
      ),
    ).toBe("input");
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ hasActionableProposedPlan: true, hasPendingApprovals: true }),
      ),
    ).toBe("approval");
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({
          hasActionableProposedPlan: true,
          session: makeSession("error"),
        }),
      ),
    ).toBe("error");
  });

  it("badges a plan that arrives while the agent is still working", () => {
    // The row stays in Implementing, but it still has to say a plan is there.
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ hasActionableProposedPlan: true, session: makeSession("running") }),
      ),
    ).toBe("plan");
  });
  // T3-CUSTOM(expbkt3): END

  it("does not add attention badges to ordinary lifecycle states", () => {
    expect(resolvePhaseSidebarAttentionKind(makeThread())).toBeNull();
    expect(resolvePhaseSidebarAttentionKind(makeThread({ session: makeSession("running") }))).toBe(
      null,
    );
    expect(
      resolvePhaseSidebarAttentionKind(
        makeThread({ interactionMode: "plan", session: makeSession("running") }),
      ),
    ).toBeNull();
  });
});

describe("phase sidebar metadata and filters", () => {
  it("resolves bridge-created branches to compact Linear issue links", () => {
    expect(resolvePhaseSidebarLinearIssue("linear/tec-145-improve-the-sidebar")).toEqual({
      identifier: "TEC-145",
      url: "https://linear.app/beknown/issue/TEC-145",
    });
    expect(resolvePhaseSidebarLinearIssue("linear/TEC-658")).toEqual({
      identifier: "TEC-658",
      url: "https://linear.app/beknown/issue/TEC-658",
    });
    expect(resolvePhaseSidebarLinearIssue("feature/tec-145")).toBeNull();
    expect(resolvePhaseSidebarLinearIssue(null)).toBeNull();
  });

  it("prefers a valid manual Linear URL and rejects non-Linear links", () => {
    expect(
      resolvePhaseSidebarLinearIssue(
        "linear/tec-145-old-issue",
        "https://linear.app/beknown/issue/TEC-811/new-title?ref=sidebar",
      ),
    ).toEqual({
      identifier: "TEC-811",
      url: "https://linear.app/beknown/issue/TEC-811",
    });
    expect(resolvePhaseSidebarLinearIssue(null, "https://example.com/TEC-811")).toBeNull();
  });

  it("formats the newest relative time as zero minutes", () => {
    expect(compactPhaseSidebarTimeLabel("just now")).toBe("0m");
    expect(compactPhaseSidebarTimeLabel("15m ago")).toBe("15m");
  });

  it("maps known provider codes and creates deterministic unknown codes", () => {
    expect(resolvePhaseSidebarProviderCode("claudeAgent")).toBe("cc");
    expect(resolvePhaseSidebarProviderCode("codex")).toBe("cx");
    expect(resolvePhaseSidebarProviderCode("opencode")).toBe("oc");
    expect(resolvePhaseSidebarProviderCode("cursor")).toBe("cu");
    expect(resolvePhaseSidebarProviderCode("grok")).toBe("gr");
    expect(resolvePhaseSidebarProviderCode("ollama_local")).toBe("ol");
    expect(resolvePhaseSidebarProviderCode("x")).toBe("xx");
  });

  it("uses canonical repository identity across environments and physical fallback otherwise", () => {
    const baseProject: Project = {
      id: projectId,
      environmentId,
      ownerUserId: null,
      memberUserIds: [],
      title: "repo",
      workspaceRoot: "/tmp/repo",
      repositoryIdentity: {
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/example/repo.git",
        },
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    };
    expect(derivePhaseSidebarRepositoryKey(baseProject)).toBe("github.com/example/repo");
    expect(
      derivePhaseSidebarRepositoryKey({
        ...baseProject,
        id: ProjectId.make("project-2"),
        environmentId: EnvironmentId.make("environment-remote"),
      }),
    ).toBe("github.com/example/repo");
    expect(derivePhaseSidebarRepositoryKey({ ...baseProject, repositoryIdentity: null })).not.toBe(
      "github.com/example/repo",
    );
  });

  it("uses project nicknames for repository facets and searches every canonical member", () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/example/repo",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/repo.git",
      },
      displayName: "example/repo",
      name: "repo",
    };
    const projects: Project[] = [
      {
        id: ProjectId.make("project-a"),
        environmentId: EnvironmentId.make("env-a"),
        ownerUserId: null,
        memberUserIds: [],
        title: "Frontend",
        workspaceRoot: "/work/repo",
        repositoryIdentity,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: ProjectId.make("project-b"),
        environmentId: EnvironmentId.make("env-b"),
        ownerUserId: null,
        memberUserIds: [],
        title: "Backend",
        workspaceRoot: "/srv/repo",
        repositoryIdentity,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    ];

    const [option] = buildPhaseSidebarRepositoryOptions(projects);
    expect(option).toMatchObject({
      key: "github.com/example/repo",
      label: "example/repo",
    });
    expect(option?.searchText).toContain("Frontend");
    expect(option?.searchText).toContain("Backend");
    expect(option?.searchText).toContain("github.com/example/repo");

    const sameNicknameOptions = buildPhaseSidebarRepositoryOptions(
      projects.map((project) => ({ ...project, title: "Work" })),
    );
    expect(sameNicknameOptions[0]?.label).toBe("Work");
  });

  it("uses OR semantics within facets and AND semantics across them", () => {
    const row = makeRow({ repositoryKey: "repo-1", phaseId: "ready", providerKind: "codex" });
    expect(matchesPhaseSidebarFilters(row, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
    expect(
      matchesPhaseSidebarFilters(row, {
        repositoryKeys: ["repo-2", "repo-1"],
        phaseIds: ["ready", "planning"],
        providerKinds: ["codex"],
        ownedByMe: false,
        participantUserIds: [],
        customGroups: [],
      }),
    ).toBe(true);
    expect(
      matchesPhaseSidebarFilters(row, {
        repositoryKeys: ["repo-1"],
        phaseIds: ["ready"],
        providerKinds: ["opencode"],
        ownedByMe: false,
        participantUserIds: [],
        customGroups: [],
      }),
    ).toBe(false);
    expect(
      buildPhaseSidebarGroups(
        [row],
        {
          repositoryKeys: ["missing"],
          phaseIds: [],
          providerKinds: [],
          ownedByMe: false,
          participantUserIds: [],
          customGroups: [],
        },
        "updated_at",
      ),
    ).toEqual([]);
  });

  it("builds removable chip metadata for every active selection", () => {
    expect(
      buildPhaseSidebarFilterChips(
        {
          repositoryKeys: ["repo-1"],
          phaseIds: ["plan_ready"],
          providerKinds: ["codex"],
          ownedByMe: false,
          participantUserIds: [],
          customGroups: [],
        },
        {
          repositories: new Map([["repo-1", "T3 Code"]]),
          providers: new Map([["codex", "Codex"]]),
        },
      ),
    ).toEqual([
      { facet: "repository", value: "repo-1", label: "T3 Code" },
      { facet: "phase", value: "plan_ready", label: "Plan Ready" },
      { facet: "provider", value: "codex", label: "Codex" },
    ]);
  });

  it("sanitizes malformed persisted values and reconciles stale options", () => {
    expect(sanitizePhaseSidebarFilters(null)).toEqual(EMPTY_PHASE_SIDEBAR_FILTERS);
    expect(
      sanitizePhaseSidebarFilters({
        repositoryKeys: ["repo-1", "repo-1", 1],
        phaseIds: ["ready", "unknown"],
        providerKinds: "codex",
      }),
    ).toEqual({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready"],
      providerKinds: [],
      ownedByMe: false,
      participantUserIds: [],
      customGroups: [],
    });

    expect(
      reconcilePhaseSidebarFilters(
        {
          repositoryKeys: ["repo-1", "stale-repo"],
          phaseIds: ["ready"],
          providerKinds: ["codex", "stale-provider"],
          ownedByMe: false,
          participantUserIds: [],
          customGroups: [],
        },
        {
          repositoryKeys: new Set(["repo-1"]),
          providerKinds: new Set(["codex"]),
          assignmentAvailable: true,
        },
      ),
    ).toEqual({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready"],
      providerKinds: ["codex"],
      ownedByMe: false,
      participantUserIds: [],
      customGroups: [],
    });
  });

  it("treats the owner and directly tagged members as assigned and everyone else as not", () => {
    const owner = UserId.make("user_owner");
    const member = UserId.make("user_member");
    const stranger = UserId.make("user_stranger");
    const thread = makeThread({ ownerUserId: owner, memberUserIds: [member] });

    expect(isThreadAssignedToUser(thread, owner)).toBe(true);
    expect(isThreadAssignedToUser(thread, member)).toBe(true);
    expect(isThreadAssignedToUser(thread, stranger)).toBe(false);
    expect(
      isThreadAssignedToUser(makeThread({ ownerUserId: null, memberUserIds: [] }), owner),
    ).toBe(false);
  });

  // T3-CUSTOM(expbkt3): the owner avatar exists to answer "whose session is
  // this?" — so it only appears when the answer is not "mine".
  describe("phaseSidebarRowOwnerAvatarUserId", () => {
    const me = UserId.make("user_me");
    const them = UserId.make("user_them");

    it("shows the owner when somebody else started the thread", () => {
      expect(phaseSidebarRowOwnerAvatarUserId({ ownerUserId: them, currentUserId: me })).toBe(them);
    });

    it("stays hidden on my own threads", () => {
      expect(phaseSidebarRowOwnerAvatarUserId({ ownerUserId: me, currentUserId: me })).toBe(null);
    });

    it("stays hidden when the thread is unowned or the operator is unknown", () => {
      expect(phaseSidebarRowOwnerAvatarUserId({ ownerUserId: null, currentUserId: me })).toBe(null);
      expect(phaseSidebarRowOwnerAvatarUserId({ ownerUserId: them, currentUserId: null })).toBe(
        null,
      );
      expect(phaseSidebarRowOwnerAvatarUserId({ ownerUserId: null, currentUserId: null })).toBe(
        null,
      );
    });
  });

  // T3-CUSTOM(expbkt3): ownership, not "owner or tagged". The old filter matched
  // the server's visibility rule, so every thread you could see satisfied it and
  // turning it on changed nothing.
  it("keeps only sessions this operator started when ownedByMe is on", () => {
    const mine = makeRow({ isOwnedByMe: true, isAssignedToMe: true });
    // Tagged into someone else's session: visible, assigned, but not mine.
    const theirs = makeRow({ isOwnedByMe: false, isAssignedToMe: true });
    const ownedFilters = { ...EMPTY_PHASE_SIDEBAR_FILTERS, ownedByMe: true };

    expect(matchesPhaseSidebarFilters(mine, ownedFilters)).toBe(true);
    expect(matchesPhaseSidebarFilters(theirs, ownedFilters)).toBe(false);
    expect(matchesPhaseSidebarFilters(theirs, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
  });

  it("requires every selected person to be on the session", () => {
    const withBoth = makeRow({ participantUserIds: ["user-a", "user-b", "user-me"] });
    const withOne = makeRow({ participantUserIds: ["user-a", "user-me"] });
    const onePerson = { ...EMPTY_PHASE_SIDEBAR_FILTERS, participantUserIds: ["user-a"] };
    const twoPeople = { ...EMPTY_PHASE_SIDEBAR_FILTERS, participantUserIds: ["user-a", "user-b"] };

    expect(matchesPhaseSidebarFilters(withOne, onePerson)).toBe(true);
    expect(matchesPhaseSidebarFilters(withBoth, onePerson)).toBe(true);
    // Two people selected asks for their shared sessions, not the union.
    expect(matchesPhaseSidebarFilters(withBoth, twoPeople)).toBe(true);
    expect(matchesPhaseSidebarFilters(withOne, twoPeople)).toBe(false);
  });

  it("counts the owner as a participant alongside tagged members", () => {
    const owner = UserId.make("user_owner");
    const member = UserId.make("user_member");

    expect(
      phaseSidebarThreadParticipantIds(makeThread({ ownerUserId: owner, memberUserIds: [member] })),
    ).toEqual([owner, member]);
    // An owner who is also tagged appears once.
    expect(
      phaseSidebarThreadParticipantIds(makeThread({ ownerUserId: owner, memberUserIds: [owner] })),
    ).toEqual([owner]);
    expect(
      phaseSidebarThreadParticipantIds(makeThread({ ownerUserId: null, memberUserIds: [member] })),
    ).toEqual([member]);
  });

  it("defaults the new facets off when missing and reads them when present", () => {
    const legacyBlob = { repositoryKeys: [], phaseIds: [], providerKinds: [] };

    expect(sanitizePhaseSidebarFilters(legacyBlob).ownedByMe).toBe(false);
    expect(sanitizePhaseSidebarFilters(legacyBlob).participantUserIds).toEqual([]);
    expect(
      sanitizePhaseSidebarFilters({
        ...legacyBlob,
        ownedByMe: true,
        participantUserIds: ["user-a", "user-a", ""],
      }),
    ).toMatchObject({ ownedByMe: true, participantUserIds: ["user-a"] });
  });

  it("clears people filters that outlive the directory or the operator identity", () => {
    const filters = {
      ...EMPTY_PHASE_SIDEBAR_FILTERS,
      ownedByMe: true,
      participantUserIds: ["user-a", "user-departed"],
    };
    const options = { repositoryKeys: new Set<string>(), providerKinds: new Set<string>() };

    expect(
      reconcilePhaseSidebarFilters(filters, { ...options, assignmentAvailable: false }),
    ).toMatchObject({ ownedByMe: false, participantUserIds: [] });
    // Without a directory set the selection is left alone: an empty list while
    // the directory loads must not wipe a good filter.
    expect(
      reconcilePhaseSidebarFilters(filters, { ...options, assignmentAvailable: true })
        .participantUserIds,
    ).toEqual(["user-a", "user-departed"]);
    expect(
      reconcilePhaseSidebarFilters(filters, {
        ...options,
        assignmentAvailable: true,
        participantUserIds: new Set(["user-a"]),
      }),
    ).toMatchObject({ ownedByMe: true, participantUserIds: ["user-a"] });
  });

  it("traverses only visible filtered rows and starts at an edge when the active row is hidden", () => {
    const visibleThreadKeys = ["environment:thread-a", "environment:thread-c"];
    expect(
      resolvePhaseSidebarTraversalTarget({
        visibleThreadKeys,
        currentThreadKey: "environment:thread-a",
        direction: "next",
      }),
    ).toBe("environment:thread-c");
    expect(
      resolvePhaseSidebarTraversalTarget({
        visibleThreadKeys,
        currentThreadKey: "environment:thread-b",
        direction: "next",
      }),
    ).toBe("environment:thread-a");
    expect(
      resolvePhaseSidebarTraversalTarget({
        visibleThreadKeys,
        currentThreadKey: "environment:thread-b",
        direction: "previous",
      }),
    ).toBe("environment:thread-c");
  });
});

describe("partitionPhaseSidebarRows", () => {
  const future = "2026-07-16T14:00:00.000Z";
  const past = "2026-07-16T09:00:00.000Z";
  const partitionOptions = { now, preciseNow: now, autoSettleAfterDays: null };
  const keysOf = (rows: ReadonlyArray<PhaseSidebarRow>) => rows.map((row) => row.thread.id);

  it("moves an explicitly settled thread off the lifecycle groups", () => {
    const row = makeRow({
      thread: makeThread({ settledOverride: "settled", settledAt: now }),
    });

    const { activeRows, settledRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(activeRows).toHaveLength(0);
    expect(settledRows).toHaveLength(1);
    expect(
      buildPhaseSidebarGroups(activeRows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at"),
    ).toHaveLength(0);
  });

  it("lets snooze outrank settled classification", () => {
    const row = makeRow({
      thread: makeThread({
        snoozedUntil: future,
        snoozedAt: past,
        settledOverride: "settled",
        settledAt: past,
      }),
    });

    const { snoozedRows, settledRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(snoozedRows).toHaveLength(1);
    expect(settledRows).toHaveLength(0);
  });

  it("keeps a snoozed thread active once it raises its hand for user input", () => {
    const row = makeRow({
      thread: makeThread({ snoozedUntil: future, snoozedAt: past, hasPendingUserInput: true }),
    });

    const { activeRows, snoozedRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(snoozedRows).toHaveLength(0);
    expect(activeRows).toHaveLength(1);
    expect(phaseSidebarNeedsUserInput(activeRows[0]!.thread)).toBe(true);
  });

  it("never parks rows whose server lacks the matching capability", () => {
    const settled = makeRow({
      thread: makeThread({ settledOverride: "settled", settledAt: now }),
      settlementSupported: false,
    });
    const snoozed = makeRow({
      thread: makeThread({ id: ThreadId.make("thread-2"), snoozedUntil: future }),
      snoozeSupported: false,
    });

    const partition = partitionPhaseSidebarRows([settled, snoozed], partitionOptions);

    expect(partition.activeRows).toHaveLength(2);
    expect(partition.settledRows).toHaveLength(0);
    expect(partition.snoozedRows).toHaveLength(0);
  });

  it("returns an elapsed snooze to the lifecycle groups", () => {
    const row = makeRow({ thread: makeThread({ snoozedUntil: past, snoozedAt: past }) });

    const { activeRows, snoozedRows } = partitionPhaseSidebarRows([row], partitionOptions);

    expect(snoozedRows).toHaveLength(0);
    expect(activeRows).toHaveLength(1);
  });

  it("orders snoozed rows by soonest wake and settled rows by most recently ended", () => {
    const soon = makeRow({
      thread: makeThread({
        id: ThreadId.make("wake-soon"),
        snoozedUntil: "2026-07-16T11:00:00.000Z",
      }),
    });
    const later = makeRow({
      thread: makeThread({ id: ThreadId.make("wake-later"), snoozedUntil: future }),
    });
    const older = makeRow({
      thread: makeThread({
        id: ThreadId.make("settled-older"),
        settledOverride: "settled",
        settledAt: past,
      }),
    });
    const newer = makeRow({
      thread: makeThread({
        id: ThreadId.make("settled-newer"),
        settledOverride: "settled",
        settledAt: now,
      }),
    });

    const partition = partitionPhaseSidebarRows([later, soon, older, newer], partitionOptions);

    expect(keysOf(partition.snoozedRows)).toEqual(["wake-soon", "wake-later"]);
    expect(keysOf(partition.settledRows)).toEqual(["settled-newer", "settled-older"]);
  });

  it("applies sidebar filters to parked rows, not just lifecycle groups", () => {
    const rows = [
      makeRow({
        thread: makeThread({ settledOverride: "settled", settledAt: now }),
        repositoryKey: "repo-1",
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-2"), snoozedUntil: future }),
        repositoryKey: "repo-2",
      }),
    ];
    const filters = { ...EMPTY_PHASE_SIDEBAR_FILTERS, repositoryKeys: ["repo-1"] };

    const partition = partitionPhaseSidebarRows(
      filterVisiblePhaseSidebarRows(rows, filters),
      partitionOptions,
    );

    expect(partition.settledRows).toHaveLength(1);
    expect(partition.snoozedRows).toHaveLength(0);
  });

  it("excludes archived rows from every section", () => {
    const rows = [makeRow({ thread: makeThread({ archivedAt: now }) })];

    const partition = partitionPhaseSidebarRows(
      filterVisiblePhaseSidebarRows(rows, EMPTY_PHASE_SIDEBAR_FILTERS),
      partitionOptions,
    );

    expect(partition.activeRows).toHaveLength(0);
    expect(partition.settledRows).toHaveLength(0);
    expect(partition.snoozedRows).toHaveLength(0);
  });
});

// T3-CUSTOM(expbkt3): session priority.
describe("phase sidebar priority", () => {
  it("ranks unprioritised threads after an explicit P4", () => {
    expect(phaseSidebarPriorityRank(makeThread({ priority: 0 }))).toBe(0);
    expect(phaseSidebarPriorityRank(makeThread({ priority: 4 }))).toBe(4);
    expect(phaseSidebarPriorityRank(makeThread())).toBeGreaterThan(4);
  });

  it("formats priorities for display", () => {
    expect(formatThreadPriority(0)).toBe("P0");
    expect(formatThreadPriority(4)).toBe("P4");
  });

  it("sorts by priority ahead of attention and recency inside a group", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-unset"), updatedAt: now }),
        phaseId: "ready",
        attentionPriority: 1,
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-p4"), priority: 4, updatedAt: now }),
        phaseId: "ready",
        attentionPriority: 1,
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-p0"), priority: 0, updatedAt: now }),
        phaseId: "ready",
        // Deliberately the *worst* attention rank: priority must still win.
        attentionPriority: 5,
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-p0"),
      ThreadId.make("thread-p4"),
      ThreadId.make("thread-unset"),
    ]);
  });

  it("ignores attention and unread state so reading a row cannot reorder its group", () => {
    const older = "2026-07-16T09:00:00.000Z";
    const rows = [
      makeRow({
        thread: makeThread({
          id: ThreadId.make("thread-older"),
          priority: 1,
          updatedAt: older,
        }),
        phaseId: "ready",
        // The worst attention rank and an unread completion: neither may hoist
        // this row above the more recent one, and clearing them must not move it.
        attentionPriority: 1,
        isUnreadCompletion: true,
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-newer"), priority: 1, updatedAt: now }),
        phaseId: "ready",
        attentionPriority: 5,
      }),
    ];
    const order = (input: ReadonlyArray<PhaseSidebarRow>) =>
      buildPhaseSidebarGroups(input, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at").flatMap((group) =>
        group.rows.map((row) => row.thread.id),
      );

    expect(order(rows)).toEqual([ThreadId.make("thread-newer"), ThreadId.make("thread-older")]);
    // Opening the unread row clears both volatile flags; the order must hold.
    expect(
      order([{ ...rows[0]!, attentionPriority: 5, isUnreadCompletion: false }, rows[1]!]),
    ).toEqual([ThreadId.make("thread-newer"), ThreadId.make("thread-older")]);
  });

  it("flips the time axis for oldest-first without touching the priority lead", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-newer"), updatedAt: now }),
        phaseId: "ready",
      }),
      makeRow({
        thread: makeThread({
          id: ThreadId.make("thread-older"),
          updatedAt: "2026-07-16T09:00:00.000Z",
        }),
        phaseId: "ready",
      }),
      makeRow({
        thread: makeThread({
          id: ThreadId.make("thread-p0"),
          priority: 0,
          updatedAt: "2026-07-16T08:00:00.000Z",
        }),
        phaseId: "ready",
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at", {
      direction: "oldest_first",
      priorityFirst: true,
    });
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-p0"),
      ThreadId.make("thread-older"),
      ThreadId.make("thread-newer"),
    ]);
  });

  it("drops the priority lead when the override is switched off", () => {
    const rows = [
      makeRow({
        thread: makeThread({
          id: ThreadId.make("thread-p0"),
          priority: 0,
          updatedAt: "2026-07-16T08:00:00.000Z",
        }),
        phaseId: "ready",
      }),
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-newer"), updatedAt: now }),
        phaseId: "ready",
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at", {
      direction: "newest_first",
      priorityFirst: false,
    });
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-newer"),
      ThreadId.make("thread-p0"),
    ]);
  });

  it("defaults unreadable persisted sort preferences back to the shipped ordering", () => {
    expect(sanitizePhaseSidebarSort(undefined)).toEqual(DEFAULT_PHASE_SIDEBAR_SORT);
    expect(sanitizePhaseSidebarSort({ direction: "sideways", priorityFirst: "yes" })).toEqual(
      DEFAULT_PHASE_SIDEBAR_SORT,
    );
    expect(sanitizePhaseSidebarSort({ direction: "oldest_first", priorityFirst: false })).toEqual({
      direction: "oldest_first",
      priorityFirst: false,
    });
  });

  it("keeps explicit priority ahead of unread status", () => {
    const rows = [
      makeRow({
        thread: makeThread({ id: ThreadId.make("thread-unread"), title: "Same title" }),
        phaseId: "ready",
        isUnreadCompletion: true,
      }),
      makeRow({
        thread: makeThread({
          id: ThreadId.make("thread-priority"),
          priority: 4,
          title: "Same title",
        }),
        phaseId: "ready",
      }),
    ];

    const groups = buildPhaseSidebarGroups(rows, EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");
    expect(groups.flatMap((group) => group.rows.map((row) => row.thread.id))).toEqual([
      ThreadId.make("thread-priority"),
      ThreadId.make("thread-unread"),
    ]);
  });

  it("fades the badge from full orange at P0 to grey at P4", () => {
    expect(phaseSidebarPriorityBadgeClassName(0)).toContain("bg-orange-500");
    expect(phaseSidebarPriorityBadgeClassName(1)).toContain(
      "bg-[color-mix(in_oklab,var(--color-orange-500)_80%,var(--color-neutral-400))]",
    );
    expect(phaseSidebarPriorityBadgeClassName(2)).toContain("var(--color-orange-500)_60%");
    expect(phaseSidebarPriorityBadgeClassName(3)).toContain("var(--color-orange-500)_40%");
    expect(phaseSidebarPriorityBadgeClassName(4)).toBe("bg-neutral-400 text-black shadow-sm");
    // Every rung keeps the same label treatment, so contrast never drifts.
    for (const priority of [0, 1, 2, 3, 4]) {
      expect(phaseSidebarPriorityBadgeClassName(priority)).toContain("text-black");
    }
    // An out-of-range value must not render an unstyled badge.
    expect(phaseSidebarPriorityBadgeClassName(9)).toBe("bg-neutral-400 text-black shadow-sm");
  });

  it("keeps the red input-needed alert independent of priority", () => {
    expect(phaseSidebarRowClassName(false, false, true)).toContain("bg-red-500/20");
    expect(phaseSidebarPriorityBadgeClassName(0)).not.toContain("bg-red-500");
  });
});

// T3-CUSTOM(expbkt3): BEGIN — signals the stock sidebar shows and this one did not.
describe("phase sidebar detected pull requests", () => {
  const detected = {
    projectId: ProjectId.make("project-1"),
    repository: "beknown-work/bkt3code",
    number: 180,
    url: "https://github.com/beknown-work/bkt3code/pull/180",
  };

  it("shows a pull request the server detected for the thread's branch", () => {
    // The auto-detected PR lives only on the thread, never in `pullRequests`,
    // so the row used to render nothing while the chat header showed it.
    const badge = resolvePhaseSidebarChangeRequestBadge(null, [], detected);

    expect(badge?.label).toBe("#180");
    expect(badge?.url).toBe(detected.url);
    expect(badge?.statusText).toBe("status pending");
  });

  it("keeps the detected review muted until its state is known", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge(null, [], detected);

    // Colouring it green would assert an "open" the row has not confirmed.
    expect(badge?.colorClassName).toBe("text-muted-foreground");
    expect(badge?.colorClassName).not.toContain("emerald");
  });

  it("enriches the detected review with live state when the two agree", () => {
    const badge = resolvePhaseSidebarChangeRequestBadge(
      { pr: { number: 180, url: detected.url, state: "open", title: "A plan" } as never },
      [],
      detected,
    );

    expect(badge?.label).toBe("#180");
    expect(badge?.statusText).toBe("open");
  });

  it("ignores a working-directory probe pointing at another thread's review", () => {
    // The probe is keyed by cwd, so on a shared local checkout it reports
    // whatever branch is checked out. The thread's own field decides identity.
    const badge = resolvePhaseSidebarChangeRequestBadge(
      {
        pr: {
          number: 999,
          url: "https://example.test/999",
          state: "open",
          title: "Other",
        } as never,
      },
      [],
      detected,
    );

    expect(badge?.label).toBe("#180");
    expect(badge?.statusText).toBe("status pending");
  });

  it("renders nothing when there is no review at all", () => {
    expect(resolvePhaseSidebarChangeRequestBadge(null, [], null)).toBeNull();
  });
});

describe("phase sidebar branch mismatch", () => {
  it("flags a local checkout sitting on another branch", () => {
    const metadata = resolvePhaseSidebarCheckoutMetadata(
      { branch: "feature/mine", worktreePath: null },
      { refName: "main", baseRef: null, pr: null } as never,
    );

    expect(metadata.branchMismatch).toBe("feature/mine");
    expect(metadata.tooltip).toContain("feature/mine");
  });

  it("stays quiet when the checkout matches the thread", () => {
    const metadata = resolvePhaseSidebarCheckoutMetadata({ branch: "main", worktreePath: null }, {
      refName: "main",
      baseRef: null,
      pr: null,
    } as never);

    expect(metadata.branchMismatch).toBeNull();
  });

  it("never flags a worktree, which owns its own checkout", () => {
    const metadata = resolvePhaseSidebarCheckoutMetadata(
      { branch: "feature/mine", worktreePath: "/tmp/wt" },
      { refName: "main", baseRef: null, pr: null } as never,
    );

    expect(metadata.branchMismatch).toBeNull();
  });

  it("names the branch in a worktree tooltip, since the label is a codename", () => {
    const metadata = resolvePhaseSidebarCheckoutMetadata(
      { branch: "feature/mine", worktreePath: "/tmp/wt" },
      null,
      { codename: "onigiri" },
    );

    expect(metadata.label).toBe("onigiri");
    expect(metadata.tooltip).toContain("feature/mine");
  });
});

describe("phase sidebar session errors", () => {
  it("badges a session error, matching how it is already grouped", () => {
    // resolvePhaseSidebarPhase already treats this as a failure, so badging on
    // execution activity alone left a row grouped as failed with no badge.
    expect(
      resolvePhaseSidebarAttentionKind(makeThread({ session: { status: "error" } as never })),
    ).toBe("error");
  });
});
// T3-CUSTOM(expbkt3): END

// T3-CUSTOM(expbkt3): BEGIN — pinning used to be a no-op the UI still offered.
describe("phase sidebar pinning", () => {
  it("sorts a pinned thread to the top of its group", () => {
    const pinned = makeRow({
      thread: makeThread({ id: ThreadId.make("thread-pinned"), pinnedAt: now }),
    });
    const ordinary = makeRow({ thread: makeThread({ id: ThreadId.make("thread-plain") }) });

    const groups = buildPhaseSidebarGroups(
      [ordinary, pinned],
      EMPTY_PHASE_SIDEBAR_FILTERS,
      "updated_at",
    );

    expect(groups[0]?.rows[0]?.thread.id).toBe(ThreadId.make("thread-pinned"));
  });

  it("leaves order alone when nothing is pinned", () => {
    const a = makeRow({ thread: makeThread({ id: ThreadId.make("thread-a") }) });
    const b = makeRow({ thread: makeThread({ id: ThreadId.make("thread-b") }) });

    const groups = buildPhaseSidebarGroups([a, b], EMPTY_PHASE_SIDEBAR_FILTERS, "updated_at");

    expect(groups[0]?.rows.map((row) => row.thread.id)).toEqual([
      ThreadId.make("thread-a"),
      ThreadId.make("thread-b"),
    ]);
  });
});
// T3-CUSTOM(expbkt3): END
