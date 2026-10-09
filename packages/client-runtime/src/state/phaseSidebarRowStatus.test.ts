// T3-CUSTOM(expbkt3): the row's working status, work badge and subagent counter.
import { ProviderInstanceId, RunId, type OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "./models.ts";
import {
  formatPhaseSidebarWorkingDuration,
  phaseSidebarActiveSubagentCount,
  phaseSidebarIsWorking,
  phaseSidebarSubagentCountLabel,
  resolvePhaseSidebarVisibleWorkBadge,
  resolvePhaseSidebarWorkingStatus,
} from "./phaseSidebar.ts";
import {
  DEFAULT_PHASE_SIDEBAR_GROUPING,
  isPhaseSidebarSectionCollapsed,
  PHASE_SIDEBAR_SHELF_SECTIONS,
  togglePhaseSidebarSectionCollapsed,
} from "./phaseSidebarGrouping.ts";

const startedAt = "2026-10-09T10:00:00.000Z";

function runtime(
  status: ThreadRuntimeSummary["status"],
  overrides: Partial<ThreadRuntimeSummary> = {},
): ThreadRuntimeSummary {
  return {
    status,
    activeRunId: RunId.make("run-1"),
    activityStartedAt: startedAt,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: startedAt,
    ...overrides,
  };
}

function thread(
  overrides: Partial<Parameters<typeof resolvePhaseSidebarWorkingStatus>[0]> = {},
): Parameters<typeof resolvePhaseSidebarWorkingStatus>[0] {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
    latestRun: null,
    goal: null,
    ...overrides,
  };
}

describe("resolvePhaseSidebarWorkingStatus", () => {
  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "reads a %s runtime as working, with the time its work started",
    (status) => {
      expect(resolvePhaseSidebarWorkingStatus(thread({ runtime: runtime(status) }))).toEqual({
        label: "Working",
        startedAt,
      });
    },
  );

  it.each(["idle", "completed", "failed", "interrupted", "cancelled"] as const)(
    "does not read a %s runtime as working",
    (status) => {
      expect(phaseSidebarIsWorking(thread({ runtime: runtime(status) }))).toBe(false);
      expect(resolvePhaseSidebarWorkingStatus(thread({ runtime: runtime(status) }))).toBeNull();
    },
  );

  it("stops reading as working while an approval or an answer is pending", () => {
    expect(
      resolvePhaseSidebarWorkingStatus(
        thread({ runtime: runtime("running"), hasPendingApprovals: true }),
      ),
    ).toBeNull();
    expect(
      resolvePhaseSidebarWorkingStatus(
        thread({ runtime: runtime("running"), hasPendingUserInput: true }),
      ),
    ).toBeNull();
  });

  it("leaves an idle turn with background work to the work badge", () => {
    // Background fleets park the runtime at idle; the WORKING badge covers them.
    expect(resolvePhaseSidebarWorkingStatus(thread({ runtime: runtime("idle") }))).toBeNull();
    expect(resolvePhaseSidebarWorkingStatus(thread({ runtime: null }))).toBeNull();
  });

  it("says Goal while a native goal keeps the agent going", () => {
    const goal = { objective: "Ship it", status: "active" } as OrchestrationV2ProviderGoal;
    expect(
      resolvePhaseSidebarWorkingStatus(thread({ runtime: runtime("running"), goal }))?.label,
    ).toBe("Goal");
    const paused = { objective: "Ship it", status: "paused" } as OrchestrationV2ProviderGoal;
    expect(
      resolvePhaseSidebarWorkingStatus(thread({ runtime: runtime("running"), goal: paused }))
        ?.label,
    ).toBe("Working");
  });

  it("keeps the label without a duration when the server cannot say when work started", () => {
    expect(
      resolvePhaseSidebarWorkingStatus(
        thread({ runtime: runtime("queued", { activityStartedAt: null }) }),
      ),
    ).toEqual({ label: "Working", startedAt: null });
  });
});

describe("formatPhaseSidebarWorkingDuration", () => {
  it("formats seconds, minutes, then hours and minutes", () => {
    expect(formatPhaseSidebarWorkingDuration(0)).toBe("0s");
    expect(formatPhaseSidebarWorkingDuration(59_999)).toBe("59s");
    expect(formatPhaseSidebarWorkingDuration(60_000)).toBe("1m");
    expect(formatPhaseSidebarWorkingDuration(65 * 60_000)).toBe("1h 5m");
  });

  it("never shows a negative or broken duration", () => {
    expect(formatPhaseSidebarWorkingDuration(-5_000)).toBe("0s");
    expect(formatPhaseSidebarWorkingDuration(Number.NaN)).toBe("0s");
  });
});

describe("resolvePhaseSidebarVisibleWorkBadge", () => {
  const running = { label: "Running", monitoring: false };
  const starting = { label: "Starting", monitoring: false };
  const working = { label: "Working", monitoring: false };
  const monitoring = { label: "Monitoring", monitoring: true };

  it("drops the badges that only repeat the working status", () => {
    expect(resolvePhaseSidebarVisibleWorkBadge(running, true)).toBeNull();
    expect(resolvePhaseSidebarVisibleWorkBadge(working, true)).toBeNull();
  });

  it("keeps STARTING and MONITORING beside the working status", () => {
    expect(resolvePhaseSidebarVisibleWorkBadge(starting, true)).toBe(starting);
    expect(resolvePhaseSidebarVisibleWorkBadge(monitoring, true)).toBe(monitoring);
  });

  it("keeps every badge when the working status is not shown", () => {
    expect(resolvePhaseSidebarVisibleWorkBadge(running, false)).toBe(running);
    expect(resolvePhaseSidebarVisibleWorkBadge(working, false)).toBe(working);
    expect(resolvePhaseSidebarVisibleWorkBadge(null, true)).toBeNull();
  });
});

describe("running subagent count", () => {
  it("reads a missing, empty or broken count as none", () => {
    expect(phaseSidebarActiveSubagentCount({ id: "thread" })).toBe(0);
    expect(phaseSidebarActiveSubagentCount({ id: "thread", activeSubagentCount: null })).toBe(0);
    expect(phaseSidebarActiveSubagentCount({ id: "thread", activeSubagentCount: -1 })).toBe(0);
    expect(phaseSidebarActiveSubagentCount({ id: "thread", activeSubagentCount: Number.NaN })).toBe(
      0,
    );
    expect(phaseSidebarActiveSubagentCount({ id: "thread", activeSubagentCount: 3 })).toBe(3);
  });

  it("labels the count in the singular and the plural", () => {
    expect(phaseSidebarSubagentCountLabel(0)).toBeNull();
    expect(phaseSidebarSubagentCountLabel(1)).toBe("1 subagent running");
    expect(phaseSidebarSubagentCountLabel(4)).toBe("4 subagents running");
  });
});

describe("parked shelf collapse keys", () => {
  it("start collapsed and stay where the user put them", () => {
    const settled = PHASE_SIDEBAR_SHELF_SECTIONS.settled;
    let grouping = DEFAULT_PHASE_SIDEBAR_GROUPING;
    expect(isPhaseSidebarSectionCollapsed(settled, new Set(grouping.collapsedSectionKeys))).toBe(
      true,
    );
    grouping = togglePhaseSidebarSectionCollapsed(grouping, settled.key);
    expect(isPhaseSidebarSectionCollapsed(settled, new Set(grouping.collapsedSectionKeys))).toBe(
      false,
    );
    grouping = togglePhaseSidebarSectionCollapsed(grouping, settled.key);
    expect(isPhaseSidebarSectionCollapsed(settled, new Set(grouping.collapsedSectionKeys))).toBe(
      true,
    );
  });
});
