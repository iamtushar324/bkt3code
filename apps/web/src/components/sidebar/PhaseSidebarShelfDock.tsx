// T3-CUSTOM(expbkt3): the parked shelves (Snoozed, Settled), docked at the
// bottom of the BK sidebar, just above the footer.
//
// They used to be the last children of the scrolling session list, so they sat
// wherever the live groups happened to end and slid out of view under any tall
// list. Here they sit outside the list: the dock never shrinks, its headers are
// always on screen, and an open shelf scrolls inside a capped box. The session
// list above is the only part of the sidebar that gives up height, so notices,
// update pills, filter banners or a long footer shrink the list, never the
// shelves.
//
// Collapse state is the persisted section state the grouping store keeps (see
// PHASE_SIDEBAR_SHELF_SECTIONS); this component only renders it.
//
// The Running shelf sits on top when custom grouping has it switched on: live
// sessions with nothing waiting on a human, as a flat list. It starts open.
import type { PhaseSidebarShelfId } from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { AlarmClockIcon, CheckIcon, ChevronDownIcon, LoaderCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { PhaseSidebarRow, PhaseSidebarShelfRows } from "./PhaseGroupedSidebar.logic";

export interface PhaseSidebarShelfDockShelf {
  /** Every row on the shelf after the filters, shown or not. */
  readonly count: number;
  readonly collapsed: boolean;
  readonly rows: PhaseSidebarShelfRows<PhaseSidebarRow>;
}

/** The Running shelf: rendered by the caller, since its rows are live session trees. */
export interface PhaseSidebarShelfDockRunningShelf {
  readonly count: number;
  readonly collapsed: boolean;
  readonly containsRoutedThread: boolean;
  /** The rows, or null while collapsed. */
  readonly items: ReactNode;
  readonly onToggle: () => void;
}

export interface PhaseSidebarShelfDockProps {
  /** Absent unless custom grouping has the Running shelf switched on. */
  readonly running?: PhaseSidebarShelfDockRunningShelf;
  readonly snoozed: PhaseSidebarShelfDockShelf;
  readonly settled: PhaseSidebarShelfDockShelf;
  readonly onToggle: (shelf: PhaseSidebarShelfId) => void;
  /** Rows one "Show more" adds to the settled shelf. */
  readonly settledPageSize: number;
  readonly onShowMoreSettled: () => void;
  readonly renderRow: (row: PhaseSidebarRow, shelf: PhaseSidebarShelfId) => ReactNode;
}

export function PhaseSidebarShelfDock(props: PhaseSidebarShelfDockProps) {
  const { running, snoozed, settled } = props;
  const runningCount = running?.count ?? 0;
  if (runningCount === 0 && snoozed.count === 0 && settled.count === 0) return null;
  return (
    <div
      data-testid="phase-sidebar-shelf-dock"
      // shrink-0 plus a height cap: the dock keeps its headers whatever else
      // grows, and an open shelf can never push the footer off screen.
      className="flex max-h-[min(45dvh,24rem)] shrink-0 flex-col gap-1 border-t border-sidebar-border px-2 pt-1.5 pb-1"
    >
      {running !== undefined && running.count > 0 ? (
        <PhaseSidebarShelf
          id="running"
          label="Running"
          count={running.count}
          collapsed={running.collapsed}
          holdsOpenThread={running.collapsed && running.containsRoutedThread}
          onToggle={running.onToggle}
          items={running.collapsed ? null : running.items}
        />
      ) : null}
      {snoozed.count > 0 ? (
        <PhaseSidebarShelf
          id="snoozed"
          label="Snoozed"
          {...parkedShelfProps("snoozed", snoozed, props)}
        />
      ) : null}
      {settled.count > 0 ? (
        <PhaseSidebarShelf
          id="settled"
          label="Settled"
          {...parkedShelfProps("settled", settled, props)}
          showMore={
            !settled.collapsed && settled.rows.hiddenCount > 0 ? (
              <button
                type="button"
                onClick={props.onShowMoreSettled}
                data-testid="phase-sidebar-settled-shelf-show-more"
                className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:text-foreground"
              >
                Show {Math.min(settled.rows.hiddenCount, props.settledPageSize)} more
                <span className="text-muted-foreground/50">
                  ({settled.rows.hiddenCount} hidden)
                </span>
              </button>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}

function parkedShelfProps(
  id: PhaseSidebarShelfId,
  shelf: PhaseSidebarShelfDockShelf,
  props: PhaseSidebarShelfDockProps,
) {
  return {
    count: shelf.count,
    collapsed: shelf.collapsed,
    // A collapsed shelf never draws the open thread's row; the header says it
    // is in here instead, one click away.
    holdsOpenThread: shelf.collapsed && shelf.rows.containsRoutedThread,
    onToggle: () => props.onToggle(id),
    items:
      shelf.rows.rendered.length > 0
        ? shelf.rows.rendered.map((row) => props.renderRow(row, id))
        : null,
  };
}

const SHELF_TONE = {
  running: {
    icon: LoaderCircleIcon,
    text: "text-sky-600 dark:text-sky-400",
    rule: "bg-sky-500/20 dark:bg-sky-400/15",
  },
  snoozed: {
    icon: AlarmClockIcon,
    text: "text-blue-600 dark:text-blue-400",
    rule: "bg-blue-500/20 dark:bg-blue-400/15",
  },
  settled: { icon: CheckIcon, text: "text-muted-foreground/50", rule: "bg-sidebar-border/60" },
} as const;

function PhaseSidebarShelf(props: {
  readonly id: keyof typeof SHELF_TONE;
  readonly label: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly holdsOpenThread: boolean;
  readonly onToggle: () => void;
  readonly items: ReactNode;
  readonly showMore?: ReactNode;
}) {
  const { id, label, count, collapsed, holdsOpenThread } = props;
  const tone = SHELF_TONE[id];
  const Icon = tone.icon;
  const hasBody = props.items != null || props.showMore != null;
  return (
    <section className="flex min-h-0 flex-col" data-testid={`phase-sidebar-${id}-shelf`}>
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={!collapsed}
        aria-label={`${label}, ${count} session${count === 1 ? "" : "s"}${
          collapsed ? ", collapsed" : ""
        }${holdsOpenThread ? ", holds the open thread" : ""}`}
        data-testid={`phase-sidebar-${id}-shelf-toggle`}
        data-holds-open-thread={holdsOpenThread ? "" : undefined}
        className="flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon aria-hidden className={cn("size-2.5 shrink-0", tone.text)} />
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider", tone.text)}>
          {label}
        </span>
        <span className={cn("h-px flex-1", tone.rule)} />
        {holdsOpenThread ? (
          <span
            aria-hidden
            data-testid={`phase-sidebar-${id}-shelf-open-thread`}
            className="size-1.5 shrink-0 rounded-full bg-primary"
          />
        ) : null}
        <span className="text-[9px] tabular-nums text-muted-foreground/55">{count}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            tone.text,
            !collapsed && "rotate-180",
          )}
        />
      </button>
      {/* A collapsed shelf renders no list at all. An empty list left in the
          tree is where auto-animate re-inserts a row it animates out, so the
          row blinks between the two; the shelves are parked history and lose
          nothing by not animating. */}
      {hasBody ? (
        <div
          data-testid={`phase-sidebar-${id}-shelf-rows`}
          className="mt-1 min-h-0 overflow-y-auto overscroll-contain"
        >
          {props.items != null ? <ul className="space-y-0.5">{props.items}</ul> : null}
          {props.showMore}
        </div>
      ) : null}
    </section>
  );
}
