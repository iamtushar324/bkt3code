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
import type { PhaseSidebarShelfId } from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { AlarmClockIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import type { PhaseSidebarRow, PhaseSidebarShelfRows } from "./PhaseGroupedSidebar.logic";

export interface PhaseSidebarShelfDockShelf {
  /** Every row on the shelf after the filters, shown or not. */
  readonly count: number;
  readonly collapsed: boolean;
  readonly rows: PhaseSidebarShelfRows<PhaseSidebarRow>;
}

export interface PhaseSidebarShelfDockProps {
  readonly snoozed: PhaseSidebarShelfDockShelf;
  readonly settled: PhaseSidebarShelfDockShelf;
  readonly onToggle: (shelf: PhaseSidebarShelfId) => void;
  /** Rows one "Show more" adds to the settled shelf. */
  readonly settledPageSize: number;
  readonly onShowMoreSettled: () => void;
  readonly renderRow: (row: PhaseSidebarRow, shelf: PhaseSidebarShelfId) => ReactNode;
}

export function PhaseSidebarShelfDock(props: PhaseSidebarShelfDockProps) {
  const { snoozed, settled } = props;
  if (snoozed.count === 0 && settled.count === 0) return null;
  return (
    <div
      data-testid="phase-sidebar-shelf-dock"
      // shrink-0 plus a height cap: the dock keeps its headers whatever else
      // grows, and an open shelf can never push the footer off screen.
      className="flex max-h-[min(45dvh,24rem)] shrink-0 flex-col gap-1 border-t border-sidebar-border px-2 pt-1.5 pb-1"
    >
      {snoozed.count > 0 ? (
        <PhaseSidebarShelf
          id="snoozed"
          label="Snoozed"
          shelf={snoozed}
          onToggle={props.onToggle}
          renderRow={props.renderRow}
        />
      ) : null}
      {settled.count > 0 ? (
        <PhaseSidebarShelf
          id="settled"
          label="Settled"
          shelf={settled}
          onToggle={props.onToggle}
          renderRow={props.renderRow}
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

function PhaseSidebarShelf(props: {
  readonly id: PhaseSidebarShelfId;
  readonly label: string;
  readonly shelf: PhaseSidebarShelfDockShelf;
  readonly onToggle: (shelf: PhaseSidebarShelfId) => void;
  readonly renderRow: (row: PhaseSidebarRow, shelf: PhaseSidebarShelfId) => ReactNode;
  readonly showMore?: ReactNode;
}) {
  const { id, label, shelf } = props;
  const snoozed = id === "snoozed";
  // A collapsed shelf never draws the open thread's row; the header says it is
  // in here instead, one click away.
  const holdsOpenThread = shelf.collapsed && shelf.rows.containsRoutedThread;
  const hasBody = shelf.rows.rendered.length > 0 || props.showMore != null;
  return (
    <section className="flex min-h-0 flex-col" data-testid={`phase-sidebar-${id}-shelf`}>
      <button
        type="button"
        onClick={() => props.onToggle(id)}
        aria-expanded={!shelf.collapsed}
        aria-label={`${label}, ${shelf.count} session${shelf.count === 1 ? "" : "s"}${
          shelf.collapsed ? ", collapsed" : ""
        }${holdsOpenThread ? ", holds the open thread" : ""}`}
        data-testid={`phase-sidebar-${id}-shelf-toggle`}
        data-holds-open-thread={holdsOpenThread ? "" : undefined}
        className="flex w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {snoozed ? (
          <AlarmClockIcon
            aria-hidden
            className="size-2.5 shrink-0 text-blue-600 dark:text-blue-400"
          />
        ) : (
          <CheckIcon aria-hidden className="size-2.5 shrink-0 text-muted-foreground/50" />
        )}
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider",
            snoozed ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50",
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "h-px flex-1",
            snoozed ? "bg-blue-500/20 dark:bg-blue-400/15" : "bg-sidebar-border/60",
          )}
        />
        {holdsOpenThread ? (
          <span
            data-testid={`phase-sidebar-${id}-shelf-open-thread`}
            className="size-1.5 shrink-0 rounded-full bg-primary"
          >
            <span className="sr-only">The open thread is on this shelf</span>
          </span>
        ) : null}
        <span className="text-[9px] tabular-nums text-muted-foreground/55">{shelf.count}</span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 transition-transform",
            snoozed ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50",
            !shelf.collapsed && "rotate-180",
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
          {shelf.rows.rendered.length > 0 ? (
            <ul className="space-y-0.5">
              {shelf.rows.rendered.map((row) => props.renderRow(row, id))}
            </ul>
          ) : null}
          {props.showMore}
        </div>
      ) : null}
    </section>
  );
}
