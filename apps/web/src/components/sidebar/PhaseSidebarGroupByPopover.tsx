/**
 * T3-CUSTOM(expbkt3): the "Group by" control in the experimental sidebar header.
 *
 * Sits where the static "Lifecycle" caption used to be, so the caption is now
 * the control: it reads as the current mode and opens the picker. Custom
 * groups are managed from the same popover — create, rename, reorder, delete —
 * because the list is short and a second surface would only spread the
 * feature thinner. The groups themselves are the threads' shared labels plus
 * the host's shared registry (names and colours, XFN-59); the parent owns the
 * reads and the server writes, this popover only asks.
 */
import {
  PHASE_SIDEBAR_GROUP_BY_LABELS,
  PHASE_SIDEBAR_GROUP_BY_MODES,
  PHASE_SIDEBAR_GROUP_ORDER_LABELS,
  PHASE_SIDEBAR_GROUP_ORDERS,
  type PhaseSidebarCustomGroupOption,
  type PhaseSidebarGroupBy,
  type PhaseSidebarGroupOrder,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { usePhaseSidebarGroupingStore } from "../../phaseSidebarGroupingStore";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { PhaseSidebarGroupColorSwatches } from "./PhaseSidebarGroupColorSwatches";
import { PhaseSidebarGroupNameDialog } from "./PhaseSidebarGroupNameDialog";

function RadioRow({
  checked,
  label,
  hint,
  onSelect,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent",
        checked ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border",
          checked ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {checked ? <span className="size-1.5 rounded-full bg-primary" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-[10px] text-muted-foreground/60">{hint}</span> : null}
    </button>
  );
}

const GROUP_BY_HINTS: Readonly<Record<PhaseSidebarGroupBy, string>> = {
  lifecycle: "by what needs you",
  project: "by repository",
  custom: "shared groups",
};

export function PhaseSidebarGroupByPopover({
  groups,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveGroup,
  onRecolorGroup,
}: {
  /** Every custom group in view, in manual order (see listPhaseSidebarCustomGroups). */
  readonly groups: ReadonlyArray<PhaseSidebarCustomGroupOption>;
  readonly onCreateGroup: (label: string) => void;
  readonly onRenameGroup: (id: string, label: string) => void;
  readonly onDeleteGroup: (id: string) => void;
  readonly onMoveGroup: (
    orderedIds: ReadonlyArray<string>,
    id: string,
    direction: "up" | "down",
  ) => void;
  /** Absent when no connected host keeps shared groups for this session. */
  readonly onRecolorGroup?: (id: string, colorId: string | null) => void;
}) {
  const grouping = usePhaseSidebarGroupingStore((state) => state.grouping);
  // The group whose colour swatches are open inline, if any.
  const [colorEditingId, setColorEditingId] = useState<string | null>(null);
  const setGroupBy = usePhaseSidebarGroupingStore((state) => state.setGroupBy);
  const setGroupOrder = usePhaseSidebarGroupingStore((state) => state.setGroupOrder);

  const [nameDialog, setNameDialog] = useState<
    | { readonly mode: "create" }
    | { readonly mode: "rename"; readonly id: string; readonly label: string }
    | null
  >(null);

  const orderVisible = grouping.groupBy !== "lifecycle";
  const orders: ReadonlyArray<PhaseSidebarGroupOrder> =
    grouping.groupBy === "custom"
      ? PHASE_SIDEBAR_GROUP_ORDERS
      : PHASE_SIDEBAR_GROUP_ORDERS.filter((order) => order !== "manual");
  // Projects have no manual order, so the stored "manual" reads as "name" there.
  const effectiveOrder =
    grouping.groupBy === "project" && grouping.groupOrder === "manual"
      ? "name"
      : grouping.groupOrder;
  const orderedIds = groups.map((group) => group.id);

  return (
    <>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              aria-label={`Group by: ${PHASE_SIDEBAR_GROUP_BY_LABELS[grouping.groupBy]}`}
              data-testid="phase-sidebar-group-by-trigger"
            />
          }
        >
          {PHASE_SIDEBAR_GROUP_BY_LABELS[grouping.groupBy]}
          <ChevronDownIcon aria-hidden className="size-3" />
        </PopoverTrigger>
        <PopoverPopup align="start" className="w-64" padding="none">
          <div className="space-y-3 p-2">
            <section>
              <h3 className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                Group by
              </h3>
              <div role="radiogroup" aria-label="Group by" className="space-y-0.5">
                {PHASE_SIDEBAR_GROUP_BY_MODES.map((mode) => (
                  <RadioRow
                    key={mode}
                    checked={grouping.groupBy === mode}
                    label={PHASE_SIDEBAR_GROUP_BY_LABELS[mode]}
                    hint={GROUP_BY_HINTS[mode]}
                    onSelect={() => setGroupBy(mode)}
                  />
                ))}
              </div>
            </section>

            {orderVisible ? (
              <section>
                <h3 className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Order groups
                </h3>
                <div role="radiogroup" aria-label="Order groups" className="space-y-0.5">
                  {orders.map((order) => (
                    <RadioRow
                      key={order}
                      checked={effectiveOrder === order}
                      label={PHASE_SIDEBAR_GROUP_ORDER_LABELS[order]}
                      onSelect={() => setGroupOrder(order)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {grouping.groupBy === "custom" ? (
              <section data-testid="phase-sidebar-custom-groups">
                <div className="mb-1 flex items-center justify-between px-2">
                  <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    Groups
                  </h3>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[11px]"
                    onClick={() => setNameDialog({ mode: "create" })}
                  >
                    <PlusIcon className="size-3" />
                    New
                  </Button>
                </div>
                {groups.length === 0 ? (
                  <p className="px-2 py-1 text-[11px] text-muted-foreground">
                    No groups yet. Create one, then use “Move to group” on any session. Groups are
                    shared with everyone who uses this environment, and agents can use them too.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {groups.map((group, index) => (
                      <li key={group.id}>
                        <div className="group/row flex min-h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-accent">
                          <span
                            aria-hidden
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              group.color === undefined && "border border-muted-foreground/40",
                            )}
                            style={
                              group.color === undefined
                                ? undefined
                                : { backgroundColor: group.color }
                            }
                          />
                          <span className="min-w-0 flex-1 truncate">{group.label}</span>
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                            {group.count}
                          </span>
                          {grouping.groupOrder === "manual" ? (
                            <>
                              <button
                                type="button"
                                aria-label={`Move ${group.label} up`}
                                disabled={index === 0}
                                onClick={() => onMoveGroup(orderedIds, group.id, "up")}
                                className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                              >
                                <ArrowUpIcon className="size-3" />
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${group.label} down`}
                                disabled={index === groups.length - 1}
                                onClick={() => onMoveGroup(orderedIds, group.id, "down")}
                                className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                              >
                                <ArrowDownIcon className="size-3" />
                              </button>
                            </>
                          ) : null}
                          {onRecolorGroup ? (
                            <button
                              type="button"
                              aria-label={`Change colour of ${group.label}`}
                              aria-expanded={colorEditingId === group.id}
                              onClick={() =>
                                setColorEditingId((current) =>
                                  current === group.id ? null : group.id,
                                )
                              }
                              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                            >
                              <PaletteIcon className="size-3" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            aria-label={`Rename ${group.label}`}
                            onClick={() =>
                              setNameDialog({ mode: "rename", id: group.id, label: group.label })
                            }
                            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                          >
                            <PencilIcon className="size-3" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${group.label}`}
                            onClick={() => onDeleteGroup(group.id)}
                            className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                          >
                            <Trash2Icon className="size-3" />
                          </button>
                        </div>
                        {onRecolorGroup && colorEditingId === group.id ? (
                          <div className="px-2 pt-1 pb-2">
                            <PhaseSidebarGroupColorSwatches
                              groupLabel={group.label}
                              value={group.colorId ?? null}
                              onSelect={(colorId) => {
                                onRecolorGroup(group.id, colorId);
                                setColorEditingId(null);
                              }}
                            />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      <PhaseSidebarGroupNameDialog
        open={nameDialog !== null}
        mode={nameDialog?.mode ?? "create"}
        initialLabel={nameDialog?.mode === "rename" ? nameDialog.label : ""}
        onOpenChange={(open) => {
          if (!open) setNameDialog(null);
        }}
        onSubmit={(label) => {
          if (nameDialog?.mode === "rename") onRenameGroup(nameDialog.id, label);
          else onCreateGroup(label);
        }}
      />
    </>
  );
}
