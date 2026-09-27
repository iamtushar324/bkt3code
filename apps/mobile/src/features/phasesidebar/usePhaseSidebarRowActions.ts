// T3-CUSTOM(expbkt3): the long-press action set for a sidebar row.
//
// Every action is capability-gated by the row model, so an older server simply
// offers fewer items rather than failing an RPC. Each action that can be
// entered can also be left — settle/unsettle, snooze/unsnooze, pin/unpin — per
// the fork's rule that a one-way door is a bug.
import {
  phaseSidebarCanForceStopAgent,
  PHASE_SIDEBAR_PRIORITY_CHOICES,
  type PhaseSidebarRow,
} from "@t3tools/client-runtime/state/phase-sidebar";
import {
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

export type PhaseSidebarRowActionId =
  | "people"
  | "mark-unread"
  | "mark-read"
  | "settle"
  | "unsettle"
  | "snooze"
  | "unsnooze"
  | "pin"
  | "unpin"
  | "archive"
  | "delete"
  | "force-stop"
  | "group"
  | "group:new"
  | "group:none"
  | `group:${string}`
  | `priority:${number}`
  | `snooze:${string}`;

export interface PhaseSidebarRowAction {
  readonly id: PhaseSidebarRowActionId;
  readonly title: string;
  /** SF Symbol name; Android falls back to its own mapping. */
  readonly image: string;
  readonly destructive?: boolean;
  /** iOS renders these as a submenu; Android as a nested sheet. */
  readonly subactions?: ReadonlyArray<PhaseSidebarRowAction>;
  /** Marks the row's current choice inside a submenu. */
  readonly checked?: boolean;
}

/**
 * The actions to offer for one row, in the order a thumb should meet them:
 * people first because tagging is the most common reason to long-press, then
 * lifecycle, then the destructive ones last.
 */
export function buildPhaseSidebarRowActions(input: {
  readonly row: PhaseSidebarRow;
  readonly now: string;
  /**
   * Mobile has no auto-settle setting of its own, so null: a row is settled
   * only when the server says so, never because a timer elapsed locally.
   */
  readonly autoSettleAfterDays?: number | null;
  /** Snooze presets to offer as a submenu; a bare Snooze item when absent. */
  readonly snoozePresets?: ReadonlyArray<SnoozePreset>;
  /**
   * The user's custom groups. "Move to group" appears whenever any exist,
   * whichever grouping mode is showing — placing a session is cheap, and the
   * group is waiting when they switch to Custom.
   */
  readonly customGroups?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly customGroupId?: string | null;
}): ReadonlyArray<PhaseSidebarRowAction> {
  const { row } = input;
  const thread = row.thread;
  const actions: PhaseSidebarRowAction[] = [{ id: "people", title: "People", image: "person.2" }];

  // Read state is per device, so it is the user's to flip either way.
  if (thread.latestTurn?.completedAt) {
    actions.push(
      row.isUnreadCompletion
        ? { id: "mark-read", title: "Mark read", image: "envelope.open" }
        : { id: "mark-unread", title: "Mark unread", image: "envelope.badge" },
    );
  }

  if (input.customGroups !== undefined) {
    actions.push({
      id: "group",
      title: "Move to group",
      image: "folder",
      subactions: [
        ...input.customGroups.map((group): PhaseSidebarRowAction => ({
          id: `group:${group.id}`,
          title: group.label,
          image: "folder",
          checked: input.customGroupId === group.id,
        })),
        ...(input.customGroupId != null
          ? [
              {
                id: "group:none",
                title: "Remove from group",
                image: "folder.badge.minus",
              } satisfies PhaseSidebarRowAction,
            ]
          : []),
        { id: "group:new", title: "New group…", image: "folder.badge.plus" },
      ],
    });
  }

  if (row.settlementSupported) {
    const settled = effectiveSettled(thread, {
      now: input.now,
      autoSettleAfterDays: input.autoSettleAfterDays ?? null,
    });
    actions.push(
      settled
        ? { id: "unsettle", title: "Reopen", image: "arrow.uturn.backward" }
        : { id: "settle", title: "Settle", image: "checkmark.circle" },
    );
  }

  if (row.snoozeSupported) {
    const snoozed = effectiveSnoozed(thread, { now: input.now });
    if (snoozed) {
      actions.push({ id: "unsnooze", title: "Wake", image: "bell" });
    } else if (canSnooze(thread, { now: input.now })) {
      const presets = input.snoozePresets ?? [];
      actions.push(
        presets.length === 0
          ? { id: "snooze", title: "Snooze", image: "clock" }
          : {
              id: "snooze",
              title: "Snooze",
              image: "clock",
              subactions: presets.map((preset) => ({
                id: `snooze:${preset.id}`,
                title: `${preset.label} · ${preset.whenLabel}`,
                image: "clock",
              })),
            },
      );
    }
  }

  actions.push(
    thread.pinnedAt == null
      ? { id: "pin", title: "Pin", image: "pin" }
      : { id: "unpin", title: "Unpin", image: "pin.slash" },
  );

  if (row.prioritySupported) {
    for (const choice of PHASE_SIDEBAR_PRIORITY_CHOICES) {
      actions.push({
        id: `priority:${choice.value}`,
        title: choice.label,
        image: "flag",
      });
    }
  }

  if (phaseSidebarCanForceStopAgent(thread.session)) {
    actions.push({
      id: "force-stop",
      title: "Force stop agent",
      image: "stop.circle",
      destructive: true,
    });
  }

  actions.push({ id: "archive", title: "Archive", image: "archivebox", destructive: true });
  actions.push({ id: "delete", title: "Delete", image: "trash", destructive: true });
  return actions;
}

/** MenuAction shape for `@react-native-menu/menu`, recursively. */
export function phaseSidebarRowActionsToMenu(actions: ReadonlyArray<PhaseSidebarRowAction>): Array<{
  id: string;
  title: string;
  image?: string;
  state?: "on" | "off";
  attributes?: { destructive?: boolean };
  subactions?: Array<{ id: string; title: string; image?: string; state?: "on" | "off" }>;
}> {
  return actions.map((action) => ({
    id: action.id,
    title: action.title,
    image: action.image,
    ...(action.checked === true ? { state: "on" as const } : {}),
    ...(action.destructive === true ? { attributes: { destructive: true } } : {}),
    ...(action.subactions !== undefined
      ? { subactions: phaseSidebarRowActionsToMenu(action.subactions) }
      : {}),
  }));
}
