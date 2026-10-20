// T3-CUSTOM(expbkt3): the docked parked shelves — headers always there, no rows
// while collapsed (the open thread included), paging inside an open shelf.
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, type Screen } from "../../../test/render";
import { resolvePhaseSidebarShelfRows, type PhaseSidebarRow } from "./PhaseGroupedSidebar.logic";
import { PhaseSidebarShelfDock, type PhaseSidebarShelfDockProps } from "./PhaseSidebarShelfDock";

function fakeRow(id: string): PhaseSidebarRow {
  return { thread: { environmentId: "local", id } } as unknown as PhaseSidebarRow;
}
const keyOf = (row: PhaseSidebarRow) => `${row.thread.environmentId}:${row.thread.id}`;

function shelf(
  ids: ReadonlyArray<string>,
  options: { collapsed: boolean; routedKey?: string; visibleCount?: number },
): PhaseSidebarShelfDockProps["snoozed"] {
  const rows = ids.map(fakeRow);
  return {
    count: rows.length,
    collapsed: options.collapsed,
    rows: resolvePhaseSidebarShelfRows({
      rows,
      collapsed: options.collapsed,
      keyOf,
      routedKey: options.routedKey ?? null,
      ...(options.visibleCount === undefined ? {} : { visibleCount: options.visibleCount }),
    }),
  };
}

async function mount(props: Pick<PhaseSidebarShelfDockProps, "running" | "snoozed" | "settled">) {
  const onToggle = vi.fn();
  const onShowMoreSettled = vi.fn();
  const screen = await render(
    <PhaseSidebarShelfDock
      {...props}
      onToggle={onToggle}
      settledPageSize={25}
      onShowMoreSettled={onShowMoreSettled}
      renderRow={(row, id) => (
        <li key={keyOf(row)} data-testid={`row-${id}`}>
          {String(row.thread.id)}
        </li>
      )}
    />,
    // The dock has no links or router hooks, and the empty case counts the container's own nodes.
    { router: false },
  );
  return Object.assign(screen, { onToggle, onShowMoreSettled });
}
const byTestId = (screen: Screen, testId: string) => [
  ...screen.container.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`),
];

describe("PhaseSidebarShelfDock", () => {
  it("renders nothing when both shelves are empty", async () => {
    await using screen = await mount({
      snoozed: shelf([], { collapsed: true }),
      settled: shelf([], { collapsed: true }),
    });

    expect(screen.container.childNodes).toHaveLength(0);
  });

  it("keeps collapsed shelves to their headers, even when one holds the open thread", async () => {
    await using screen = await mount({
      snoozed: shelf(["s1"], { collapsed: true }),
      settled: shelf(["t1", "t2"], { collapsed: true, routedKey: "local:t2" }),
    });

    expect(byTestId(screen, "row-snoozed")).toHaveLength(0);
    expect(byTestId(screen, "row-settled")).toHaveLength(0);
    expect(byTestId(screen, "phase-sidebar-settled-shelf-rows")).toHaveLength(0);
    const toggle = byTestId(screen, "phase-sidebar-settled-shelf-toggle")[0]!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(byTestId(screen, "phase-sidebar-settled-shelf-open-thread")).toHaveLength(1);
    expect(byTestId(screen, "phase-sidebar-snoozed-shelf-open-thread")).toHaveLength(0);
  });

  it("asks to toggle the shelf whose header was clicked", async () => {
    await using screen = await mount({
      snoozed: shelf(["s1"], { collapsed: true }),
      settled: shelf(["t1"], { collapsed: true }),
    });

    await userEvent.click(byTestId(screen, "phase-sidebar-snoozed-shelf-toggle")[0]!);

    expect(screen.onToggle).toHaveBeenCalledWith("snoozed");
  });

  it("pages an open settled shelf inside its own scroll box", async () => {
    await using screen = await mount({
      snoozed: shelf(["s1"], { collapsed: true }),
      settled: shelf(["t1", "t2", "t3"], { collapsed: false, visibleCount: 2 }),
    });

    expect(byTestId(screen, "row-settled")).toHaveLength(2);
    expect(byTestId(screen, "phase-sidebar-settled-shelf-open-thread")).toHaveLength(0);
    const showMore = byTestId(screen, "phase-sidebar-settled-shelf-show-more")[0]!;
    await userEvent.click(showMore);
    expect(screen.onShowMoreSettled).toHaveBeenCalledTimes(1);
  });

  it("shows the Running shelf on top, open with its rows, and toggles it on its own", async () => {
    const onToggleRunning = vi.fn();
    await using screen = await mount({
      running: {
        count: 1,
        collapsed: false,
        containsRoutedThread: false,
        items: <li data-testid="row-running">r1</li>,
        onToggle: onToggleRunning,
      },
      snoozed: shelf([], { collapsed: true }),
      settled: shelf([], { collapsed: true }),
    });

    expect(byTestId(screen, "row-running")).toHaveLength(1);
    await userEvent.click(byTestId(screen, "phase-sidebar-running-shelf-toggle")[0]!);
    expect(onToggleRunning).toHaveBeenCalledTimes(1);
    expect(screen.onToggle).not.toHaveBeenCalled();
  });

  it("keeps a collapsed Running shelf to its header and marks the open thread", async () => {
    await using screen = await mount({
      running: {
        count: 2,
        collapsed: true,
        containsRoutedThread: true,
        items: <li data-testid="row-running">r1</li>,
        onToggle: vi.fn(),
      },
      snoozed: shelf([], { collapsed: true }),
      settled: shelf([], { collapsed: true }),
    });

    expect(byTestId(screen, "row-running")).toHaveLength(0);
    expect(byTestId(screen, "phase-sidebar-running-shelf-open-thread")).toHaveLength(1);
  });
});
