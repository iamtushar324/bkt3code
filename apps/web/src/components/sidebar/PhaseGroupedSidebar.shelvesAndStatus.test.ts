// T3-CUSTOM(expbkt3): parked shelves render nothing while collapsed, and the
// row's "Working 4m" follows upstream's rule and format exactly.
import { ProviderInstanceId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatWorkingDurationLabel, resolveSidebarThreadStatus } from "../Sidebar.logic";
import {
  formatPhaseSidebarWorkingDuration,
  resolvePhaseSidebarShelfRows,
  resolvePhaseSidebarWorkingStatus,
} from "./PhaseGroupedSidebar.logic";

interface FakeRow {
  readonly key: string;
}
const rows: ReadonlyArray<FakeRow> = ["a", "b", "c", "d"].map((key) => ({ key }));
const keyOf = (row: FakeRow) => row.key;

describe("resolvePhaseSidebarShelfRows", () => {
  it("renders no rows in a collapsed shelf, even the open thread's", () => {
    const shelf = resolvePhaseSidebarShelfRows({ rows, collapsed: true, keyOf, routedKey: "c" });

    expect(shelf.rendered).toEqual([]);
    expect(shelf.hiddenCount).toBe(0);
    // The header carries the signal instead.
    expect(shelf.containsRoutedThread).toBe(true);
  });

  it("renders every row of an open shelf without paging", () => {
    const shelf = resolvePhaseSidebarShelfRows({ rows, collapsed: false, keyOf, routedKey: null });

    expect(shelf.rendered.map(keyOf)).toEqual(["a", "b", "c", "d"]);
    expect(shelf.hiddenCount).toBe(0);
    expect(shelf.containsRoutedThread).toBe(false);
  });

  it("pages an open shelf and counts what Show more would add", () => {
    const shelf = resolvePhaseSidebarShelfRows({
      rows,
      collapsed: false,
      keyOf,
      routedKey: "b",
      visibleCount: 2,
    });

    expect(shelf.rendered.map(keyOf)).toEqual(["a", "b"]);
    expect(shelf.hiddenCount).toBe(2);
  });

  it("adds the open thread to an open shelf when it is paged out", () => {
    const shelf = resolvePhaseSidebarShelfRows({
      rows,
      collapsed: false,
      keyOf,
      routedKey: "d",
      visibleCount: 2,
    });

    expect(shelf.rendered.map(keyOf)).toEqual(["a", "b", "d"]);
    expect(shelf.hiddenCount).toBe(1);
    expect(shelf.containsRoutedThread).toBe(true);
  });
});

// The working rule and the duration format are copied into client-runtime so
// mobile can share them. These cases fail as soon as upstream changes either.
describe("working status parity with upstream's sidebar", () => {
  const runtimeStatuses = [
    "idle",
    "preparing",
    "queued",
    "starting",
    "running",
    "waiting",
    "completed",
    "interrupted",
    "failed",
    "cancelled",
    "rolled_back",
  ] as const;

  const cases = runtimeStatuses.flatMap((status) =>
    [
      { hasPendingApprovals: false, hasPendingUserInput: false },
      { hasPendingApprovals: true, hasPendingUserInput: false },
      { hasPendingApprovals: false, hasPendingUserInput: true },
    ].map((pending) => ({ status, ...pending })),
  );

  it.each(cases)(
    "agrees with upstream for a $status runtime (approval $hasPendingApprovals, input $hasPendingUserInput)",
    ({ status, hasPendingApprovals, hasPendingUserInput }) => {
      const thread = {
        hasPendingApprovals,
        hasPendingUserInput,
        runtime: {
          status,
          activeRunId: RunId.make("run-1"),
          activityStartedAt: "2026-10-09T10:00:00.000Z",
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-10-09T10:00:00.000Z",
        },
        latestRun: null,
        goal: null,
      };
      expect(resolvePhaseSidebarWorkingStatus(thread) !== null).toBe(
        resolveSidebarThreadStatus(thread) === "working",
      );
    },
  );

  it("agrees with upstream without a runtime", () => {
    const thread = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      latestRun: null,
      goal: null,
    };
    expect(resolvePhaseSidebarWorkingStatus(thread)).toBeNull();
    expect(resolveSidebarThreadStatus(thread)).not.toBe("working");
  });

  it.each([
    0,
    999,
    1_000,
    59_999,
    60_000,
    3_599_999,
    3_600_000,
    3_900_000,
    90_061_000,
    -1,
    Number.NaN,
  ])("formats %d ms as upstream does", (elapsedMs) => {
    expect(formatPhaseSidebarWorkingDuration(elapsedMs)).toBe(
      formatWorkingDurationLabel(elapsedMs),
    );
  });
});
