// T3-CUSTOM(expbkt3): the mobile phase-grouped sidebar list.
//
// Grouping, nesting, filtering and sorting are all decided by client-runtime, so
// this component owns exactly two things: expansion state, and turning the
// resulting sections into a flat list a FlatList can render efficiently.
// Rendering the tree as one flat array matters on a phone — a nested render
// tree of hundreds of rows drops frames on scroll.
//
// Parked sessions (snoozed, settled) never mix with live work: they sit in
// their own collapsed shelves under the grouped sections, as on web.
import {
  flattenPhaseSidebarTree,
  type PhaseSidebarTreeNode,
} from "@t3tools/client-runtime/state/phase-sidebar-tree";
import {
  buildPhaseSidebarSections,
  buildPhaseSidebarShelfSections,
  isPhaseSidebarSectionCollapsed,
  listPhaseSidebarCustomGroups,
  movePhaseSidebarCustomGroup,
  phaseSidebarCustomGroupIdForRow,
  phaseSidebarSectionPhase,
  togglePhaseSidebarSectionCollapsed,
  type PhaseSidebarGroupingPreferences,
  type PhaseSidebarSection,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import {
  comparePhaseSidebarRows,
  compactPhaseSidebarTimeLabel,
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  partitionPhaseSidebarRows,
  resolvePhaseSidebarWorktreeView,
  type PhaseSidebarFilters,
  type PhaseSidebarRow,
  type PhaseSidebarSortPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar";
import {
  canSnooze,
  resolveSnoozePresets,
  snoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
import { type SidebarThreadSortOrder, type UserId } from "@t3tools/contracts";
import type { MenuAction, NativeActionEvent } from "@react-native-menu/menu";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { runOnJS } from "react-native-reanimated";
import { FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { PhaseSidebarRowView, type PhaseSidebarRowSwipe } from "./PhaseSidebarRowView";
import type { MobileEnvironmentAppearance } from "../environments/environmentAppearance";
import { phaseSidebarSectionToneClassName } from "./phaseSidebarRowTone";
import {
  buildPhaseSidebarRowActions,
  phaseSidebarRowActionsToMenu,
} from "./usePhaseSidebarRowActions";
import { usePhaseSidebarDrag } from "./usePhaseSidebarDrag";
import type { PendingDraftTask } from "../../state/pending-new-tasks-model";
import { PhaseSidebarDraftHeader } from "./PhaseSidebarDraftHeader";
import {
  buildPhaseSidebarDraftItems,
  PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
  type PhaseSidebarDraftListItem,
} from "./phaseSidebarDrafts";

/** Which shelf a row sits on, if any. Drives its swipe and its time label. */
type PhaseSidebarRowShelf = "active" | "snoozed" | "settled";

/** A flattened list entry: a section header, a thread row, or a local draft. */
type PhaseSidebarListItem =
  | PhaseSidebarDraftListItem
  | {
      readonly kind: "section";
      readonly key: string;
      readonly section: PhaseSidebarSection;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly node: PhaseSidebarTreeNode;
      readonly shelf: PhaseSidebarRowShelf;
    };

/** What the header of a custom group can do, beyond collapsing. */
export type PhaseSidebarSectionActionId = "rename" | "delete" | "move-up" | "move-down";

export interface PhaseSidebarListProps {
  readonly rows: ReadonlyArray<PhaseSidebarRow>;
  readonly drafts: ReadonlyArray<PendingDraftTask>;
  readonly renderDraftRow: (draft: PendingDraftTask) => ReactElement;
  readonly viewerUserId: UserId | null;
  readonly activeThreadKey: string | null;
  readonly filters?: PhaseSidebarFilters;
  readonly sort?: PhaseSidebarSortPreferences;
  readonly sortOrder?: SidebarThreadSortOrder;
  readonly grouping: PhaseSidebarGroupingPreferences;
  readonly onChangeGrouping: (
    apply: (current: PhaseSidebarGroupingPreferences) => PhaseSidebarGroupingPreferences,
  ) => void;
  readonly projectLabelFor?: (environmentId: string, projectId: string) => string | null;
  readonly environmentLabelFor?: (environmentId: string) => string | null;
  /** Resolved identity per environment; rows show it only when several mix. */
  readonly environmentAppearanceFor?: (environmentId: string) => MobileEnvironmentAppearance | null;
  readonly onSelectRow: (row: PhaseSidebarRow) => void;
  /** Fired with the chosen action id from the row's long-press menu or swipe. */
  readonly onRowAction: (row: PhaseSidebarRow, actionId: string) => void;
  readonly onSectionAction: (
    section: PhaseSidebarSection,
    actionId: PhaseSidebarSectionActionId,
  ) => void;
  /** Re-parent a thread. Null parent means 'make this a root thread'. */
  readonly onReparentRow?: (subject: PhaseSidebarRow, parent: PhaseSidebarRow | null) => void;
  /** Reorder a pinned thread to sit before another. */
  readonly onReorderRow?: (subject: PhaseSidebarRow, before: PhaseSidebarRow) => void;
  readonly ListHeaderComponent?: ComponentProps<typeof FlatList>["ListHeaderComponent"];
  readonly ListEmptyComponent?: ComponentProps<typeof FlatList>["ListEmptyComponent"];
  readonly contentInsetAdjustmentBehavior?: ComponentProps<
    typeof FlatList
  >["contentInsetAdjustmentBehavior"];
  readonly contentContainerStyle?: ComponentProps<typeof FlatList>["contentContainerStyle"];
}

/**
 * Swipe actions follow the shelf, as in the stock list: live rows settle (full
 * swipe), snooze and archive; a snoozed row wakes; a settled row reopens.
 */
function resolveRowSwipe(
  row: PhaseSidebarRow,
  shelf: PhaseSidebarRowShelf,
  now: string,
  snoozeMenu: MenuAction[],
): PhaseSidebarRowSwipe {
  if (shelf === "snoozed") return { primary: "unsnooze", snoozeMenu: null, archive: true };
  if (shelf === "settled") return { primary: "unsettle", snoozeMenu: null, archive: true };
  const snoozable = row.snoozeSupported && canSnooze(row.thread, { now });
  return {
    primary: row.settlementSupported ? "settle" : "archive",
    snoozeMenu: snoozable ? snoozeMenu : null,
    archive: row.settlementSupported,
  };
}

/** "2h" for live and settled rows; "Wakes 9:00 AM" for a snoozed one. */
function resolveRowTimeLabel(row: PhaseSidebarRow, shelf: PhaseSidebarRowShelf, now: string) {
  if (shelf === "snoozed" && row.thread.snoozedUntil != null) {
    return snoozeWakeLabel(row.thread.snoozedUntil, { now });
  }
  return compactPhaseSidebarTimeLabel(relativeTime(row.thread.updatedAt));
}

export function PhaseSidebarList(props: PhaseSidebarListProps) {
  const filters = props.filters ?? EMPTY_PHASE_SIDEBAR_FILTERS;
  const sort = props.sort ?? DEFAULT_PHASE_SIDEBAR_SORT;
  // Contracts' settings default, which upstream no longer exports.
  const sortOrder: SidebarThreadSortOrder = props.sortOrder ?? "updated_at";
  const { grouping, onChangeGrouping, onSectionAction } = props;
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const mutedColor = String(useUniwindTheme()["--color-icon"]);
  // One open row at a time, as in the stock list: opening another closes the
  // first, and starting a scroll closes whichever is open.
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);
  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) openSwipeableRef.current = null;
  }, []);
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  // "Now" is fixed per row set so labels and presets stay stable across a
  // scroll — the same cadence the stock list uses.
  const nowIso = useMemo(() => new Date().toISOString(), [props.rows]);

  const worktreeView = useMemo(
    // Resolved across the whole set, not per row: codenames disambiguate against
    // each other and occupancy is a count.
    () => resolvePhaseSidebarWorktreeView(props.rows.map((row) => row.thread)),
    [props.rows],
  );

  // Mobile has no auto-settle setting of its own, so a row is settled only when
  // the server says so, never because a timer elapsed locally.
  const partition = useMemo(
    () =>
      partitionPhaseSidebarRows(props.rows, {
        now: nowIso,
        preciseNow: nowIso,
        autoSettleAfterDays: null,
      }),
    [nowIso, props.rows],
  );

  const { sections, forcedExpansionKeys } = useMemo(() => {
    const built = buildPhaseSidebarSections({
      rows: partition.activeRows,
      filters,
      compareSiblings: (left, right) => comparePhaseSidebarRows(left, right, sortOrder, sort),
      grouping,
      ...(props.projectLabelFor ? { projectLabelFor: props.projectLabelFor } : {}),
      ...(props.environmentLabelFor ? { environmentLabelFor: props.environmentLabelFor } : {}),
    });
    return {
      sections: [
        ...built.sections,
        ...buildPhaseSidebarShelfSections({
          snoozedRows: partition.snoozedRows,
          settledRows: partition.settledRows,
        }),
      ],
      forcedExpansionKeys: built.forcedExpansionKeys,
    };
  }, [
    filters,
    grouping,
    partition,
    props.environmentLabelFor,
    props.projectLabelFor,
    sort,
    sortOrder,
  ]);
  const collapsedSectionKeys = useMemo(
    () => new Set(grouping.collapsedSectionKeys),
    [grouping.collapsedSectionKeys],
  );

  // Parents default to open, so a session tree is visible without hunting. A
  // filter can force a parent open; that never touches the user's own state.
  const isExpanded = useCallback(
    (key: string) => forcedExpansionKeys.has(key) || !collapsedKeys.has(key),
    [collapsedKeys, forcedExpansionKeys],
  );

  const items = useMemo<ReadonlyArray<PhaseSidebarListItem>>(() => {
    const flat: PhaseSidebarListItem[] = [
      ...buildPhaseSidebarDraftItems(props.drafts, collapsedSectionKeys),
    ];
    for (const section of sections) {
      // Lifecycle and project sections exist only because they have rows; an
      // empty custom group still renders so it can be found and filled.
      if (section.nodes.length === 0 && section.kind !== "custom") continue;
      const collapsed = isPhaseSidebarSectionCollapsed(section, collapsedSectionKeys);
      flat.push({ kind: "section", key: section.key, section, collapsed });
      if (collapsed) continue;
      const shelf: PhaseSidebarRowShelf =
        section.id === "snoozed" ? "snoozed" : section.id === "settled" ? "settled" : "active";
      for (const node of flattenPhaseSidebarTree(section.nodes, isExpanded)) {
        flat.push({ kind: "row", key: node.key, node, shelf });
      }
    }
    return flat;
  }, [collapsedSectionKeys, isExpanded, props.drafts, sections]);

  const snoozePresets = useMemo<ReadonlyArray<SnoozePreset>>(
    () => resolveSnoozePresets(new Date(nowIso)),
    [nowIso],
  );
  const snoozeMenu = useMemo<MenuAction[]>(
    () =>
      snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
    [snoozePresets],
  );
  // The groups in view are the threads' own labels (plus this device's empty
  // placeholders); a row's own group is read straight off the row.
  const customGroups = useMemo(
    () =>
      listPhaseSidebarCustomGroups(props.rows, grouping).map((group) => ({
        id: group.id,
        label: group.label,
      })),
    [grouping, props.rows],
  );
  const rowActionsFor = useCallback(
    (row: PhaseSidebarRow, _rowKey: string, depth: number): MenuAction[] =>
      phaseSidebarRowActionsToMenu(
        buildPhaseSidebarRowActions({
          row,
          now: nowIso,
          snoozePresets,
          // A nested row is placed with its parent, so only roots can be moved.
          // Offered even before any group exists: "New group…" makes the first one.
          ...(depth === 0
            ? { customGroups, customGroupId: phaseSidebarCustomGroupIdForRow(row) }
            : {}),
        }),
      ) as MenuAction[],
    [customGroups, nowIso, snoozePresets],
  );

  const noopReparent = useCallback(() => {}, []);
  const dragEnabled = props.onReparentRow !== undefined || props.onReorderRow !== undefined;
  const dragController = usePhaseSidebarDrag({
    rows: props.rows,
    rowKeyFor: (row) => `${row.thread.environmentId}:${row.thread.id}`,
    onReparent: props.onReparentRow ?? noopReparent,
    onReorder: props.onReorderRow ?? noopReparent,
  });

  const handleRowGeometry = useCallback(
    (key: string, y: number, height: number, depth: number) => {
      dragController.registerGeometry(key, { y, height, depth });
    },
    [dragController],
  );

  // A dedicated grab handle rather than a long-press: long-press already opens
  // the row's context menu, and a pan that activates anywhere on the row fights
  // the list's scroll. Only pinned rows carry one — theirs is the only order
  // the user owns; everything else is sorted for them.
  const dragHandleFor = useCallback(
    (rowKey: string) => {
      const gesture = Gesture.Pan()
        .activateAfterLongPress(0)
        .onStart(() => {
          runOnJS(dragController.beginDrag)(rowKey);
        })
        .onUpdate((event) => {
          runOnJS(dragController.updateDrag)(event.absoluteY);
        })
        .onEnd(() => {
          runOnJS(dragController.endDrag)();
        })
        .onFinalize(() => {
          runOnJS(dragController.cancelDrag)();
        });
      return (
        <GestureDetector gesture={gesture}>
          <View accessibilityLabel="Drag to reorder" className="ml-1 shrink-0 px-1 py-1">
            <SymbolView
              name="line.3.horizontal"
              size={12}
              tintColor={mutedColor}
              type="monochrome"
            />
          </View>
        </GestureDetector>
      );
    },
    [dragController, mutedColor],
  );

  const handleToggleExpanded = useCallback((row: PhaseSidebarRow) => {
    setCollapsedKeys((current) => {
      const key = `${row.thread.environmentId}:${row.thread.id}`;
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleToggleSection = useCallback(
    (section: PhaseSidebarSection) =>
      onChangeGrouping((current) => togglePhaseSidebarSectionCollapsed(current, section.key)),
    [onChangeGrouping],
  );
  const handleToggleDrafts = useCallback(
    () =>
      onChangeGrouping((current) =>
        togglePhaseSidebarSectionCollapsed(current, PHASE_SIDEBAR_DRAFTS_SECTION_KEY),
      ),
    [onChangeGrouping],
  );

  // The custom sections as they are on screen (Ungrouped excluded): what a
  // manual reorder moves within.
  const customSectionIds = useMemo(
    () =>
      sections
        .filter((section) => section.kind === "custom" && !section.isUngrouped)
        .map((section) => section.id),
    [sections],
  );
  const sectionMenuFor = useCallback(
    (section: PhaseSidebarSection): MenuAction[] => {
      const customIndex = customSectionIds.indexOf(section.id);
      const manual = grouping.groupOrder === "manual";
      return [
        { id: "rename", title: "Rename group", image: "pencil" },
        ...(manual
          ? [
              {
                id: "move-up",
                title: "Move up",
                image: "arrow.up",
                attributes: { disabled: customIndex <= 0 },
              },
              {
                id: "move-down",
                title: "Move down",
                image: "arrow.down",
                attributes: { disabled: customIndex >= customSectionIds.length - 1 },
              },
            ]
          : []),
        {
          id: "delete",
          title: "Delete group",
          image: "trash",
          attributes: { destructive: true },
        },
      ];
    },
    [customSectionIds, grouping.groupOrder],
  );
  // Reordering is presentation, so it stays in this list; rename and delete
  // relabel sessions on the server and go up to the pane.
  const handleSectionAction = useCallback(
    (section: PhaseSidebarSection, actionId: PhaseSidebarSectionActionId) => {
      if (actionId === "move-up" || actionId === "move-down") {
        onChangeGrouping((current) =>
          movePhaseSidebarCustomGroup(
            current,
            customSectionIds,
            section.id,
            actionId === "move-up" ? "up" : "down",
          ),
        );
        return;
      }
      onSectionAction(section, actionId);
    },
    [customSectionIds, onChangeGrouping, onSectionAction],
  );

  // Only mark rows with their machine when the sessions on screen actually span
  // more than one environment; a second remote with nothing in view is not a
  // reason to badge every row.
  const spansEnvironments = useMemo(() => {
    const ids = new Set<string>();
    for (const row of props.rows) ids.add(row.thread.environmentId);
    return ids.size > 1;
  }, [props.rows]);
  const environmentAppearanceFor = props.environmentAppearanceFor;

  const renderSectionHeader = (section: PhaseSidebarSection, collapsed: boolean) => {
    const phaseId = phaseSidebarSectionPhase(section);
    const { summary } = section;
    const isShelf = section.collapsedByDefault;
    const header = (
      <Pressable
        accessibilityLabel={`${section.label}, ${section.nodes.length} session${section.nodes.length === 1 ? "" : "s"}${collapsed ? ", collapsed" : ""}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        className={cn("flex-row items-center gap-2 px-4 pb-1.5", isShelf ? "pt-5" : "pt-4")}
        onPress={() => handleToggleSection(section)}
      >
        <SymbolView
          name={collapsed ? "chevron.right" : "chevron.down"}
          size={10}
          tintColor={mutedColor}
          type="monochrome"
        />
        <Text
          className={cn(
            "font-t3-bold text-[11px] uppercase tracking-wide",
            isShelf
              ? "text-foreground-tertiary"
              : phaseId === null
                ? "text-foreground-secondary"
                : phaseSidebarSectionToneClassName(phaseId),
          )}
          numberOfLines={1}
        >
          {section.label}
        </Text>
        <Text className="min-w-0 flex-1 text-[10px] text-foreground-tertiary" numberOfLines={1}>
          {section.helperText}
        </Text>
        {collapsed && summary.attention > 0 ? (
          <Text className="rounded-full bg-adaptive-rose-500-a12-a16 px-1.5 font-t3-mono text-[10px] text-adaptive-rose-700-300">
            {summary.attention}
          </Text>
        ) : null}
        {collapsed && summary.running > 0 ? (
          <Text className="rounded-full bg-adaptive-sky-500-a12-a16 px-1.5 font-t3-mono text-[10px] text-adaptive-sky-700-300">
            {summary.running}
          </Text>
        ) : null}
        {collapsed && summary.unread > 0 ? (
          <Text className="rounded-full bg-adaptive-emerald-500-a12-a16 px-1.5 font-t3-mono text-[10px] text-adaptive-emerald-700-300">
            {summary.unread}
          </Text>
        ) : null}
        <Text className="font-t3-mono text-[10px] text-foreground-tertiary">
          {section.nodes.length}
        </Text>
      </Pressable>
    );
    if (section.kind !== "custom" || section.isUngrouped) return header;
    // A custom group's header is also where it is managed: hold for rename,
    // reorder and delete, the same way a row is managed.
    return (
      <ControlPillMenu
        actions={sectionMenuFor(section)}
        isAnchoredToRight
        onPressAction={(event: NativeActionEvent) =>
          handleSectionAction(section, event.nativeEvent.event as PhaseSidebarSectionActionId)
        }
        shouldOpenOnLongPress
        title={section.label}
      >
        {header}
      </ControlPillMenu>
    );
  };

  return (
    <SwipeableScrollGateProvider enabled={swipeEnabled}>
      <FlatList
        ListEmptyComponent={props.ListEmptyComponent}
        ListHeaderComponent={props.ListHeaderComponent}
        automaticallyAdjustsScrollIndicatorInsets={
          props.contentInsetAdjustmentBehavior === "automatic"
        }
        contentContainerStyle={props.contentContainerStyle}
        contentInsetAdjustmentBehavior={props.contentInsetAdjustmentBehavior ?? "never"}
        data={items}
        initialNumToRender={24}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.key}
        renderItem={({ item }) =>
          item.kind === "drafts-section" ? (
            <PhaseSidebarDraftHeader
              collapsed={item.collapsed}
              count={item.count}
              onToggle={handleToggleDrafts}
            />
          ) : item.kind === "draft" ? (
            props.renderDraftRow(item.draft)
          ) : item.kind === "section" ? (
            renderSectionHeader(item.section, item.collapsed)
          ) : (
            <PhaseSidebarRowView
              dragHandle={
                dragEnabled && item.node.row.thread.pinnedAt != null
                  ? dragHandleFor(item.node.key)
                  : undefined
              }
              dropRejectionLabel={dragController.drag?.rejectionLabel ?? null}
              indentDepth={item.node.depth}
              isDragging={dragController.drag?.subjectKey === item.node.key}
              isDropTarget={dragController.drag?.intent.targetKey === item.node.key}
              onLayoutGeometry={handleRowGeometry}
              rowKey={item.node.key}
              isActive={props.activeThreadKey === item.node.key}
              isExpanded={isExpanded(item.node.key)}
              actions={rowActionsFor(item.node.row, item.node.key, item.node.depth)}
              onPress={props.onSelectRow}
              onPressAction={props.onRowAction}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              onToggleExpanded={handleToggleExpanded}
              environmentAppearance={
                spansEnvironments && environmentAppearanceFor
                  ? environmentAppearanceFor(item.node.row.thread.environmentId)
                  : null
              }
              row={item.node.row}
              subtreeCount={item.node.descendantCount}
              swipe={resolveRowSwipe(item.node.row, item.shelf, nowIso, snoozeMenu)}
              timeLabel={resolveRowTimeLabel(item.node.row, item.shelf, nowIso)}
              viewerUserId={props.viewerUserId}
              worktreeView={worktreeView}
            />
          )
        }
        showsVerticalScrollIndicator={false}
        {...scrollGateHandlers}
        scrollEventThrottle={16}
        windowSize={11}
      />
    </SwipeableScrollGateProvider>
  );
}
