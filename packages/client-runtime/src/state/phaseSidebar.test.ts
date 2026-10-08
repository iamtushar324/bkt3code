import {
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPhaseSidebarFilterChips,
  buildPhaseSidebarGroups,
  buildPhaseSidebarRows,
  hasUnseenCompletion,
  collectDescendantThreadIds,
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  isRunningSessionPhase,
  isThreadUnread,
  matchesPhaseSidebarFilters,
  partitionPhaseSidebarRows,
  PHASE_SIDEBAR_UNGROUPED_ID,
  resolveMoveUnderCandidates,
  resolvePhaseSidebarPhase,
  resolveThreadVisitTimestamp,
  runningSessionDividerPhase,
  sanitizePhaseSidebarFilters,
  shouldShowRunningSessionGlint,
  summarizeSidebarSessions,
  type PhaseSidebarRow,
} from "./phaseSidebar.ts";
import type { EnvironmentProject, EnvironmentThreadShell } from "./shell.ts";

// The bulk of this module's behaviour is covered by the web suite that has
// exercised it since it lived under apps/web (it still imports it, through the
// re-export shim). What is asserted here is what the MOVE is responsible for:
// that the shared code runs under React Native's engine, and that the pieces
// folded in from sibling web modules survived intact.

const now = "2026-01-01T00:00:00.000Z";
const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function makeThread(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: ThreadId.make("thread-1"),
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
    source: {} as EnvironmentThreadShell["source"],
    ...overrides,
  } as EnvironmentThreadShell;
}

function makeRow(thread: EnvironmentThreadShell): PhaseSidebarRow {
  return {
    thread,
    phaseId: resolvePhaseSidebarPhase(thread),
    repositoryKey: "repo",
    repositoryLabel: "repo",
    providerKind: "codex",
    providerName: "Codex",
    isAssignedToMe: false,
    isOwnedByMe: false,
    participantUserIds: [],
    attentionPriority: 0,
    isUnreadCompletion: false,
    settlementSupported: true,
    snoozeSupported: true,
    prioritySupported: true,
    changeRequestState: null,
  };
}

/**
 * Runs `body` with Array.prototype.toSorted removed.
 *
 * Hermes — the engine the React Native app runs on — does not ship the ES2023
 * change-array-by-copy methods. This module used to live in apps/web, where a
 * browser always has them, so every sort in it is exactly the kind of thing
 * that would work in every test and then crash on a phone.
 */
function withoutHermesUnsafeArrayMethods<A>(body: () => A): A {
  const descriptors = (["toSorted", "toReversed", "toSpliced", "with"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(Array.prototype, name)] as const,
  );
  for (const [name] of descriptors) Reflect.deleteProperty(Array.prototype, name);
  try {
    return body();
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor !== undefined) Reflect.defineProperty(Array.prototype, name, descriptor);
    }
  }
}

describe("Hermes compatibility", () => {
  it("groups and partitions without ES2023 array methods", () => {
    const threads = [
      makeThread({ id: ThreadId.make("thread-1"), title: "Alpha" }),
      makeThread({
        id: ThreadId.make("thread-2"),
        title: "Beta",
        runtime: {
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          providerName: "codex",
          lastError: null,
          updatedAt: now,
        },
      }),
      // settledOverride is the explicit settle; settledAt alone only stamps
      // when it happened.
      makeThread({
        id: ThreadId.make("thread-3"),
        title: "Gamma",
        settledOverride: "settled",
        settledAt: now,
      }),
    ];

    const result = withoutHermesUnsafeArrayMethods(() => {
      const partition = partitionPhaseSidebarRows(threads.map(makeRow), {
        now,
        preciseNow: now,
        autoSettleAfterDays: null,
      });
      return {
        partition,
        groups: buildPhaseSidebarGroups(
          partition.activeRows,
          EMPTY_PHASE_SIDEBAR_FILTERS,
          "updated_at",
          DEFAULT_PHASE_SIDEBAR_SORT,
        ),
      };
    });

    expect(result.partition.settledRows).toHaveLength(1);
    expect(result.partition.activeRows).toHaveLength(2);
    expect(result.groups.flatMap((group) => group.rows)).toHaveLength(2);
  });

  it("resolves move-under candidates without ES2023 array methods", () => {
    const subject = makeThread({ id: ThreadId.make("subject") });
    const other = makeThread({ id: ThreadId.make("other"), title: "Other session" });

    const candidates = withoutHermesUnsafeArrayMethods(() =>
      resolveMoveUnderCandidates({
        threads: [subject, other],
        subject,
        query: "",
        repositoryLabelFor: () => "repo",
      }),
    );

    expect(candidates.map((candidate) => candidate.thread.id)).toEqual([other.id]);
  });
});

describe("move-under candidates", () => {
  it("refuses a descendant, mirroring the server's cycle guard", () => {
    const parent = makeThread({ id: ThreadId.make("parent") });
    const child = makeThread({ id: ThreadId.make("child"), parentThreadId: parent.id });
    const grandchild = makeThread({ id: ThreadId.make("grandchild"), parentThreadId: child.id });

    // T3-CUSTOM(expbkt3): descendants are (environment, thread) pairs now that a
    // lineage can cross environments and a bare id is ambiguous across them.
    expect([...collectDescendantThreadIds([parent, child, grandchild], parent.id)]).toEqual([
      `${parent.environmentId}:${child.id}`,
      `${parent.environmentId}:${grandchild.id}`,
    ]);

    const candidates = resolveMoveUnderCandidates({
      threads: [parent, child, grandchild],
      subject: parent,
      query: "",
      repositoryLabelFor: () => "repo",
    });
    expect(candidates).toHaveLength(0);
  });

  // T3-CUSTOM(expbkt3): BEGIN — lineage may cross environments.
  it("offers a thread on another environment, so work can span machines", () => {
    const subject = makeThread({ id: ThreadId.make("subject") });
    const foreign = makeThread({
      id: ThreadId.make("foreign"),
      environmentId: EnvironmentId.make("env-2"),
    });

    const candidates = resolveMoveUnderCandidates({
      threads: [subject, foreign],
      subject,
      query: "",
      repositoryLabelFor: () => "repo",
    });
    expect(candidates.map((candidate) => candidate.thread.id)).toEqual([foreign.id]);
  });

  it("still refuses a descendant that reached this thread through another environment", () => {
    const parent = makeThread({ id: ThreadId.make("parent") });
    const remoteChild = makeThread({
      id: ThreadId.make("remote-child"),
      environmentId: EnvironmentId.make("env-2"),
      parentThreadId: parent.id,
      parentEnvironmentId: parent.environmentId,
    });

    expect([...collectDescendantThreadIds([parent, remoteChild], parent.id)]).toEqual([
      `${remoteChild.environmentId}:${remoteChild.id}`,
    ]);

    const candidates = resolveMoveUnderCandidates({
      threads: [parent, remoteChild],
      subject: parent,
      query: "",
      repositoryLabelFor: () => "repo",
    });
    expect(candidates).toHaveLength(0);
  });

  it("does not re-offer a parent that lives on another environment", () => {
    const remoteParent = makeThread({
      id: ThreadId.make("remote-parent"),
      environmentId: EnvironmentId.make("env-2"),
    });
    const subject = makeThread({
      id: ThreadId.make("subject"),
      parentThreadId: remoteParent.id,
      parentEnvironmentId: remoteParent.environmentId,
    });

    const candidates = resolveMoveUnderCandidates({
      threads: [subject, remoteParent],
      subject,
      query: "",
      repositoryLabelFor: () => "repo",
    });
    expect(candidates).toHaveLength(0);
  });
  // T3-CUSTOM(expbkt3): END
});

describe("lifecycle counters", () => {
  it("splits running from idle and reports the next wake", () => {
    const counts = summarizeSidebarSessions(
      [
        makeThread({
          id: ThreadId.make("a"),
          runtime: {
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "running",
            providerName: "codex",
            lastError: null,
            updatedAt: now,
          },
        }),
        makeThread({ id: ThreadId.make("b") }),
        makeThread({
          id: ThreadId.make("c"),
          snoozedUntil: "2026-01-01T03:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("d"),
          snoozedUntil: "2026-01-01T01:00:00.000Z",
        }),
        // Archived and settled threads are not part of the working set.
        makeThread({ id: ThreadId.make("e"), archivedAt: now }),
        makeThread({ id: ThreadId.make("f"), settledAt: now }),
      ],
      { now, snoozeSupported: () => true },
    );

    expect(counts.running).toBe(1);
    expect(counts.nonRunning).toBe(1);
    expect(counts.nextSnoozeWakeAt).toBe("2026-01-01T01:00:00.000Z");
  });

  // T3-CUSTOM(expbkt3): subagents are hidden from the session list, so they
  // must not inflate its counters either.
  it("does not count subagent threads", () => {
    const counts = summarizeSidebarSessions(
      [
        makeThread({ id: ThreadId.make("session") }),
        makeThread({
          id: ThreadId.make("subagent"),
          lineage: {
            rootThreadId: ThreadId.make("session"),
            parentThreadId: ThreadId.make("session"),
            relationshipToParent: "subagent",
          },
        }),
      ],
      { now, snoozeSupported: () => true },
    );
    expect(counts.nonRunning).toBe(1);
  });

  it("counts a snoozed thread as idle where the server cannot snooze", () => {
    const counts = summarizeSidebarSessions(
      [makeThread({ snoozedUntil: "2026-01-01T01:00:00.000Z" })],
      { now, snoozeSupported: () => false },
    );
    expect(counts.nonRunning).toBe(1);
    expect(counts.nextSnoozeWakeAt).toBeNull();
  });
});

describe("running-session emphasis", () => {
  it("marks only live lifecycle phases", () => {
    expect(isRunningSessionPhase("planning")).toBe(true);
    expect(isRunningSessionPhase("implementing")).toBe(true);
    expect(isRunningSessionPhase("ready")).toBe(false);
  });

  it("never emphasises parked history", () => {
    expect(shouldShowRunningSessionGlint("planning", "active")).toBe(true);
    expect(shouldShowRunningSessionGlint("planning", "settled")).toBe(false);
    expect(shouldShowRunningSessionGlint("planning", "snoozed")).toBe(false);
  });

  it("places one divider before running work, and none when all rows run", () => {
    expect(runningSessionDividerPhase(["ready", "planning", "implementing"])).toBe("planning");
    expect(runningSessionDividerPhase(["planning", "implementing"])).toBeNull();
    expect(runningSessionDividerPhase(["ready"])).toBeNull();
  });
});

describe("unread tracking", () => {
  it("prefers the newer of thread update and turn completion", () => {
    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-01-01T00:00:00.000Z",
        latestTurnCompletedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).toBe("2026-01-01T01:00:00.000Z");

    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-01-01T02:00:00.000Z",
        latestTurnCompletedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).toBe("2026-01-01T02:00:00.000Z");
  });

  it("is unread only when activity is newer than this device's last visit", () => {
    const base = {
      threadUpdatedAt: "2026-01-01T02:00:00.000Z",
      latestTurnCompletedAt: null,
    };
    expect(isThreadUnread({ ...base, lastVisitedAt: "2026-01-01T01:00:00.000Z" })).toBe(true);
    expect(isThreadUnread({ ...base, lastVisitedAt: "2026-01-01T03:00:00.000Z" })).toBe(false);
  });

  it("treats a never-visited thread as read", () => {
    // Otherwise a fresh install marks every row in the list unread.
    expect(
      isThreadUnread({
        threadUpdatedAt: now,
        latestTurnCompletedAt: null,
        lastVisitedAt: null,
      }),
    ).toBe(false);
  });

  it("does not mark a row unread on an unparseable timestamp", () => {
    expect(
      isThreadUnread({
        threadUpdatedAt: "not-a-date",
        latestTurnCompletedAt: null,
        lastVisitedAt: now,
      }),
    ).toBe(false);
  });
});

// T3-CUSTOM(expbkt3): row assembly moved out of apps/web so the mobile phase
// sidebar builds identical rows. These are the fork-owned proof that the move
// preserved behaviour, and that mobile can rely on it after an upstream merge.
describe("buildPhaseSidebarRows", () => {
  const project = {
    id: projectId,
    environmentId,
    title: "beknown-services",
    workspaceRoot: "/home/dev/beknown-services",
  } as EnvironmentProject;

  const buildOne = (
    thread: EnvironmentThreadShell,
    input: Partial<Parameters<typeof buildPhaseSidebarRows>[0]> = {},
  ) =>
    buildPhaseSidebarRows({
      threads: [thread],
      projects: [project],
      serverConfigs: new Map(),
      vcsStatusByThreadKey: new Map(),
      lastVisitedAtByThreadKey: {},
      currentUserId: null,
      allEnvironmentShellsLive: true,
      lastKnownPhaseByThreadKey: null,
      ...input,
    })[0]!;

  it("labels the row with its project title", () => {
    expect(buildOne(makeThread()).repositoryLabel).toBe("beknown-services");
  });

  it("falls back to a readable label when the project is unknown", () => {
    const row = buildOne(makeThread(), { projects: [] });
    expect(row.repositoryLabel).toBe("Unknown repository");
  });

  it("reports every capability as unsupported when no server config is known", () => {
    const row = buildOne(makeThread());
    expect(row.settlementSupported).toBe(false);
    expect(row.snoozeSupported).toBe(false);
    expect(row.prioritySupported).toBe(false);
    expect(row.linearIssueSupported).toBe(false);
    expect(row.mattermostLinkSupported).toBe(false);
  });

  it("reads capabilities from the thread's own environment config", () => {
    const row = buildOne(makeThread(), {
      serverConfigs: new Map([
        [
          environmentId,
          {
            environment: {
              capabilities: { threadSettlement: true, threadMattermostLink: true },
            },
            providers: [],
          },
        ],
      ]) as never,
    });
    expect(row.settlementSupported).toBe(true);
    expect(row.mattermostLinkSupported).toBe(true);
    expect(row.snoozeSupported).toBe(false);
  });

  it("marks ownership and assignment against the current user", () => {
    const mine = makeThread({ ownerUserId: "user-1" as never });
    const row = buildOne(mine, { currentUserId: "user-1" as never });
    expect(row.isOwnedByMe).toBe(true);
    expect(row.isAssignedToMe).toBe(true);
  });

  it("does not claim ownership when nobody is signed in", () => {
    const row = buildOne(makeThread({ ownerUserId: "user-1" as never }));
    expect(row.isOwnedByMe).toBe(false);
    expect(row.isAssignedToMe).toBe(false);
  });

  // `resolvePhaseSidebarDisplayPhase` currently ignores the previous phase (its
  // parameter is vestigial), so the display phase always follows the live one.
  // The builder still threads the map through, so if that anti-flap behaviour is
  // ever restored both clients get it at once.
  it("follows the live phase regardless of the last known one", () => {
    const thread = makeThread();
    const threadKey = `${environmentId}:${thread.id}`;
    for (const allEnvironmentShellsLive of [true, false]) {
      const row = buildOne(thread, {
        allEnvironmentShellsLive,
        lastKnownPhaseByThreadKey: new Map([[threadKey, "implementing" as const]]),
      });
      expect(row.phaseId).toBe(resolvePhaseSidebarPhase(thread));
    }
  });

  it("builds one row per thread", () => {
    const rows = buildPhaseSidebarRows({
      threads: [makeThread({ id: ThreadId.make("a") }), makeThread({ id: ThreadId.make("b") })],
      projects: [project],
      serverConfigs: new Map(),
      vcsStatusByThreadKey: new Map(),
      lastVisitedAtByThreadKey: {},
      currentUserId: null,
      allEnvironmentShellsLive: true,
      lastKnownPhaseByThreadKey: null,
    });
    expect(rows.map((row) => row.thread.id)).toEqual(["a", "b"]);
  });

  // T3-CUSTOM(expbkt3): only sessions a user can talk to get a row. A
  // subagent is left out, while a child session made with t3_create_session
  // (fork parent link, no subagent lineage) keeps its row and nests.
  it("leaves subagent threads out and keeps child sessions", () => {
    const parentId = ThreadId.make("parent");
    const rows = buildPhaseSidebarRows({
      threads: [
        makeThread({ id: parentId }),
        makeThread({ id: ThreadId.make("child-session"), parentThreadId: parentId }),
        makeThread({
          id: ThreadId.make("subagent"),
          parentThreadId: parentId,
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "subagent",
          },
        }),
        makeThread({
          id: ThreadId.make("fork"),
          lineage: {
            rootThreadId: parentId,
            parentThreadId: parentId,
            relationshipToParent: "fork",
          },
        }),
      ],
      projects: [project],
      serverConfigs: new Map(),
      vcsStatusByThreadKey: new Map(),
      lastVisitedAtByThreadKey: {},
      currentUserId: null,
      allEnvironmentShellsLive: true,
      lastKnownPhaseByThreadKey: null,
    });
    expect(rows.map((row) => row.thread.id)).toEqual(["parent", "child-session", "fork"]);
  });

  // T3-CUSTOM(expbkt3): custom sidebar group — the thread's label wins, a
  // device-local placement fills in only while the thread has none.
  it("files the row under the thread's custom group, falling back to the local placement", () => {
    const localCustomGroupForKey = (threadKey: string) =>
      threadKey.endsWith(":legacy") ? "Legacy" : null;
    expect(buildOne(makeThread({ customGroup: "Sprint 42" })).customGroup).toBe("Sprint 42");
    expect(
      buildOne(makeThread({ id: ThreadId.make("legacy"), customGroup: null }), {
        localCustomGroupForKey,
      }).customGroup,
    ).toBe("Legacy");
    expect(
      buildOne(makeThread({ id: ThreadId.make("legacy"), customGroup: "Server" }), {
        localCustomGroupForKey,
      }).customGroup,
    ).toBe("Server");
    expect(buildOne(makeThread()).customGroup).toBeNull();
  });
});

// T3-CUSTOM(expbkt3): the Group facet works in every grouping mode.
describe("custom group filter facet", () => {
  const grouped = { ...makeRow(makeThread()), customGroup: "Sprint 42" };
  const loose = makeRow(makeThread({ id: ThreadId.make("thread-2") }));

  it("matches selected groups case-insensitively and Ungrouped for rows with none", () => {
    const filters = { ...EMPTY_PHASE_SIDEBAR_FILTERS, customGroups: ["sprint 42"] };
    expect(matchesPhaseSidebarFilters(grouped, filters)).toBe(true);
    expect(matchesPhaseSidebarFilters(loose, filters)).toBe(false);
    const ungrouped = {
      ...EMPTY_PHASE_SIDEBAR_FILTERS,
      customGroups: [PHASE_SIDEBAR_UNGROUPED_ID],
    };
    expect(matchesPhaseSidebarFilters(grouped, ungrouped)).toBe(false);
    expect(matchesPhaseSidebarFilters(loose, ungrouped)).toBe(true);
    expect(matchesPhaseSidebarFilters(loose, EMPTY_PHASE_SIDEBAR_FILTERS)).toBe(true);
  });

  it("renders chips with the display label and survives storage", () => {
    const filters = {
      ...EMPTY_PHASE_SIDEBAR_FILTERS,
      customGroups: ["sprint 42", PHASE_SIDEBAR_UNGROUPED_ID, "unknown"],
    };
    const chips = buildPhaseSidebarFilterChips(filters, {
      repositories: new Map(),
      providers: new Map(),
      customGroups: new Map([["sprint 42", "Sprint 42"]]),
    });
    expect(chips.map((chip) => [chip.facet, chip.label])).toEqual([
      ["group", "Sprint 42"],
      ["group", "Ungrouped"],
      ["group", "unknown"],
    ]);
    expect(sanitizePhaseSidebarFilters({ customGroups: ["a", "", 3, "a"] }).customGroups).toEqual([
      "a",
    ]);
    expect(sanitizePhaseSidebarFilters({}).customGroups).toEqual([]);
  });
});

describe("hasUnseenCompletion", () => {
  it("is false when the turn never completed", () => {
    expect(hasUnseenCompletion({ latestRun: null, lastVisitedAt: now })).toBe(false);
  });

  it("is false when the thread was never visited", () => {
    expect(
      hasUnseenCompletion({ latestRun: { completedAt: now } as never, lastVisitedAt: undefined }),
    ).toBe(false);
  });

  it("is true when the turn finished after the last visit", () => {
    expect(
      hasUnseenCompletion({
        latestRun: { completedAt: "2026-08-31T12:00:00.000Z" } as never,
        lastVisitedAt: "2026-08-31T11:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("treats an unparseable visit timestamp as unread", () => {
    expect(
      hasUnseenCompletion({
        latestRun: { completedAt: "2026-08-31T12:00:00.000Z" } as never,
        lastVisitedAt: "not-a-date",
      }),
    ).toBe(true);
  });
});
