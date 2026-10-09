// T3-CUSTOM(expbkt3): the docked parked shelves — headers always there, no rows
// while collapsed (the open thread included), paging inside an open shelf.
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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

const onToggle = vi.fn();
const onShowMoreSettled = vi.fn();
let renderer: ReactTestRenderer | null = null;

function mount(props: Pick<PhaseSidebarShelfDockProps, "snoozed" | "settled">) {
  act(() => {
    renderer = create(
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
    );
  });
}
const byTestId = (testId: string) => renderer!.root.findAllByProps({ "data-testid": testId });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onToggle.mockReset();
  onShowMoreSettled.mockReset();
});
afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("PhaseSidebarShelfDock", () => {
  it("renders nothing when both shelves are empty", () => {
    mount({ snoozed: shelf([], { collapsed: true }), settled: shelf([], { collapsed: true }) });

    expect(renderer!.toJSON()).toBeNull();
  });

  it("keeps collapsed shelves to their headers, even when one holds the open thread", () => {
    mount({
      snoozed: shelf(["s1"], { collapsed: true }),
      settled: shelf(["t1", "t2"], { collapsed: true, routedKey: "local:t2" }),
    });

    expect(byTestId("row-snoozed")).toHaveLength(0);
    expect(byTestId("row-settled")).toHaveLength(0);
    expect(byTestId("phase-sidebar-settled-shelf-rows")).toHaveLength(0);
    const toggle = byTestId("phase-sidebar-settled-shelf-toggle")[0]!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(byTestId("phase-sidebar-settled-shelf-open-thread")).toHaveLength(1);
    expect(byTestId("phase-sidebar-snoozed-shelf-open-thread")).toHaveLength(0);
  });

  it("asks to toggle the shelf whose header was clicked", () => {
    mount({
      snoozed: shelf(["s1"], { collapsed: true }),
      settled: shelf(["t1"], { collapsed: true }),
    });

    act(() => byTestId("phase-sidebar-snoozed-shelf-toggle")[0]!.props.onClick());

    expect(onToggle).toHaveBeenCalledWith("snoozed");
  });

  it("pages an open settled shelf inside its own scroll box", () => {
    mount({
      snoozed: shelf(["s1"], { collapsed: true }),
      settled: shelf(["t1", "t2", "t3"], { collapsed: false, visibleCount: 2 }),
    });

    expect(byTestId("row-settled")).toHaveLength(2);
    expect(byTestId("phase-sidebar-settled-shelf-open-thread")).toHaveLength(0);
    const showMore = byTestId("phase-sidebar-settled-shelf-show-more")[0]!;
    act(() => showMore.props.onClick());
    expect(onShowMoreSettled).toHaveBeenCalledTimes(1);
  });
});
