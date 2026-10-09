// T3-CUSTOM(expbkt3): the whole phase sidebar as one mountable pane.
//
// Two surfaces need it and neither may drift from the other: `HomeScreen` is the
// thread list on a phone (compact layout), while `ThreadNavigationSidebar` is
// the split-view pane on a tablet. Wiring it in only one of those was the
// original bug — the tablet pane does not render at all on a phone, so the
// Settings toggle appeared to do nothing.
//
// Everything below is wiring. Grouping, filtering, sorting, row metadata and
// the drop rules all live in client-runtime or this feature's pure modules.
import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_PHASE_SIDEBAR_SORT,
  EMPTY_PHASE_SIDEBAR_FILTERS,
  PHASE_SIDEBAR_PRIORITY_CHOICES,
  type PhaseSidebarFilters,
  type PhaseSidebarRow,
  type PhaseSidebarSortPreferences,
} from "@t3tools/client-runtime/state/phase-sidebar";
import {
  createPhaseSidebarCustomGroup,
  deletePhaseSidebarCustomGroup,
  listPhaseSidebarCustomGroups,
  movePhaseSidebarCustomGroup,
  PHASE_SIDEBAR_GROUP_BY_LABELS,
  phaseSidebarCustomGroupIdForRow,
  rememberPhaseSidebarCustomGroupOrder,
  renamePhaseSidebarCustomGroup,
  type PhaseSidebarSection,
} from "@t3tools/client-runtime/state/phase-sidebar-grouping";
import { phaseSidebarFiltersActive } from "@t3tools/client-runtime/state/phase-sidebar-tree";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useCallback, useMemo, useState, type ComponentProps } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { threadListEnvironmentsAtom } from "../../state/server";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { usePendingNewTasks, type PendingDraftTask } from "../../state/use-pending-new-tasks";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { ThreadListV2PendingRow } from "../threads/thread-list-v2-items";
import { useEnvironmentAppearances } from "../environments/useEnvironmentAppearance";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadListActions } from "../home/useThreadListActions";
import { resolveThreadListV2SnoozeMenuSelection } from "../threads/threadListV2";
import { PhaseSidebarCounters } from "./PhaseSidebarCounters";
import { PhaseSidebarFilterSheet } from "./PhaseSidebarFilterSheet";
import {
  PhaseSidebarGroupBySheet,
  type PhaseSidebarGroupBySheetIntent,
} from "./PhaseSidebarGroupBySheet";
import { PhaseSidebarList, type PhaseSidebarSectionActionId } from "./PhaseSidebarList";
import { PhaseSidebarSheetModal } from "./PhaseSidebarSheetModal";
import {
  usePhaseSidebarGrouping,
  useUpdatePhaseSidebarGrouping,
} from "./phaseSidebarGroupingStore";
import {
  useClearPhaseSidebarThreadVisit,
  useMarkPhaseSidebarThreadVisited,
} from "./phaseSidebarVisitStore";
import {
  filterPhaseSidebarRowsForHost,
  type PhaseSidebarHostFilters,
} from "./phaseSidebarHostFilters";
import { usePhaseSidebarRows, usePhaseSidebarViewerUserId } from "./usePhaseSidebarRows";
// T3-CUSTOM(expbkt3): shared custom groups and their colours (XFN-59).
import { usePhaseSidebarCustomGroupRegistry } from "./usePhaseSidebarCustomGroupRegistry";
import { selectPhaseSidebarDrafts } from "./phaseSidebarDrafts";

function HeaderButton(props: {
  readonly icon: ComponentProps<typeof SymbolView>["name"];
  readonly label: string;
  readonly active: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = String(useUniwindTheme()["--color-icon"]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.active }}
      className={cn(
        "h-8 flex-row items-center gap-1.5 rounded-lg border px-2.5",
        props.active ? "border-primary bg-primary/15" : "border-border bg-subtle",
      )}
      hitSlop={6}
      onPress={props.onPress}
    >
      <SymbolView name={props.icon} size={12} tintColor={iconColor} type="monochrome" />
      <Text className="text-xs font-t3-medium text-foreground">{props.label}</Text>
      <SymbolView name="chevron.down" size={9} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}

export function PhaseSidebarPane(props: {
  /**
   * Whose operator identity the ownership facets resolve against. Null falls
   * back to the first connected environment, so "started by me" still means
   * something when the phone is showing every environment at once.
   */
  readonly viewerEnvironmentId: EnvironmentId | null;
  /** Home's search, project and environment scope. */
  readonly homeFilters: PhaseSidebarHostFilters;
  readonly selectedThreadKey: string | null;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  /** Passed straight to the list so each host can clear its own chrome. */
  readonly contentInsetAdjustmentBehavior?: ComponentProps<
    typeof FlatList
  >["contentInsetAdjustmentBehavior"];
  readonly contentContainerStyle?: ComponentProps<typeof FlatList>["contentContainerStyle"];
}) {
  const navigation = useNavigation();
  const projects = useProjects();
  const projectByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [scopedProjectKey(project.environmentId, project.id), project]),
      ),
    [projects],
  );
  const pendingTasks = usePendingNewTasks();
  const drafts = useMemo(
    () => selectPhaseSidebarDrafts(pendingTasks, props.homeFilters),
    [pendingTasks, props.homeFilters],
  );
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { machineByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const renderDraftRow = useCallback(
    (draft: PendingDraftTask) => (
      <ThreadListV2PendingRow
        environmentLabel={
          Object.keys(savedConnectionsById).length > 1
            ? (savedConnectionsById[draft.environmentId]?.environmentLabel ?? null)
            : null
        }
        environmentMachine={machineByEnvironmentId.get(draft.environmentId)}
        onDeletePendingTask={confirmDeletePendingTask}
        onSelectPendingTask={openPendingTask}
        pane="screen"
        pendingTask={draft}
        project={projectByKey.get(scopedProjectKey(draft.environmentId, draft.projectId)) ?? null}
        showPendingDivider={false}
        showTrailingDivider={false}
      />
    ),
    [
      confirmDeletePendingTask,
      machineByEnvironmentId,
      openPendingTask,
      projectByKey,
      savedConnectionsById,
    ],
  );
  const { environments } = useEnvironments();
  const viewerEnvironmentId = props.viewerEnvironmentId ?? environments[0]?.environmentId ?? null;
  const allRows = usePhaseSidebarRows({ viewerEnvironmentId });
  const rows = useMemo(
    () => filterPhaseSidebarRowsForHost(allRows, props.homeFilters),
    [allRows, props.homeFilters],
  );
  const viewerUserId = usePhaseSidebarViewerUserId(viewerEnvironmentId);
  const markVisited = useMarkPhaseSidebarThreadVisited();
  const clearVisit = useClearPhaseSidebarThreadVisit();
  const grouping = usePhaseSidebarGrouping();
  const updateGrouping = useUpdatePhaseSidebarGrouping();
  // XFN-59: the hosts' shared groups (names, colours, empty groups) and the
  // settings writes that change them. Without a host that keeps the registry,
  // groups stay this device's placeholders.
  const customGroupRegistry = usePhaseSidebarCustomGroupRegistry({
    preferredEnvironmentId: viewerEnvironmentId,
    scopeEnvironmentId: props.homeFilters.selectedEnvironmentId,
  });
  const sharedCustomGroups = customGroupRegistry.registry;
  const canRecolorCustomGroups = customGroupRegistry.homeEnvironmentId !== null;
  // Every custom group in view — the threads' shared labels, the registry's
  // groups and this device's empty placeholders — for the row menu, the sheet
  // and the filter.
  const customGroups = useMemo(
    () => listPhaseSidebarCustomGroups(rows, grouping, sharedCustomGroups),
    [grouping, rows, sharedCustomGroups],
  );

  const [filters, setFilters] = useState<PhaseSidebarFilters>(EMPTY_PHASE_SIDEBAR_FILTERS);
  const [sort, setSort] = useState<PhaseSidebarSortPreferences>(DEFAULT_PHASE_SIDEBAR_SORT);
  const [sheet, setSheet] = useState<
    | { readonly kind: "filter" }
    | { readonly kind: "group"; readonly intent: PhaseSidebarGroupBySheetIntent }
    | null
  >(null);

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    unsettleThread,
    pinThread,
    unpinThread,
    // T3-CUSTOM(expbkt3): upstream generalised the pinned-reorder action into
    // `moveThread`, which infers the pinned section from the thread itself.
    moveThread,
  } = useThreadListActions();
  // The two row actions useThreadListActions does not cover.
  const updateThreadMetadata = useAtomCommand(
    threadEnvironment.updateMetadata,
    "phase sidebar update thread metadata",
  );
  // Force stop ends the provider session, as the web sidebar does.
  const stopSession = useAtomCommand(threadEnvironment.stopSession, "phase sidebar force stop");

  // Placing a session in a group is a thread.meta.update: the label is shared,
  // so every device and every agent sees the same placement.
  const setThreadCustomGroup = useCallback(
    (thread: EnvironmentThreadShell, customGroup: string | null) => {
      if ((thread.customGroup ?? null) === customGroup) return;
      void updateThreadMetadata({
        environmentId: thread.environmentId,
        input: { threadId: thread.id, customGroup },
      });
    },
    [updateThreadMetadata],
  );
  // Renaming or deleting a group changes the registry on every host that holds
  // it and relabels every session filed under it.
  const {
    createGroup: createSharedCustomGroup,
    renameGroup: renameSharedCustomGroup,
    deleteGroup: deleteSharedCustomGroup,
    recolorGroup: recolorSharedCustomGroup,
  } = customGroupRegistry;
  const renameCustomGroup = useCallback(
    (groupId: string, label: string) => {
      updateGrouping((current) => renamePhaseSidebarCustomGroup(current, groupId, label));
      renameSharedCustomGroup(groupId, label);
      for (const row of rows) {
        if (phaseSidebarCustomGroupIdForRow(row) === groupId) {
          setThreadCustomGroup(row.thread, label);
        }
      }
    },
    [renameSharedCustomGroup, rows, setThreadCustomGroup, updateGrouping],
  );
  const deleteCustomGroup = useCallback(
    (groupId: string) => {
      updateGrouping((current) => deletePhaseSidebarCustomGroup(current, groupId));
      deleteSharedCustomGroup(groupId);
      for (const row of rows) {
        if (phaseSidebarCustomGroupIdForRow(row) === groupId)
          setThreadCustomGroup(row.thread, null);
      }
    },
    [deleteSharedCustomGroup, rows, setThreadCustomGroup, updateGrouping],
  );
  const recolorCustomGroup = useCallback(
    (groupId: string, colorId: string | null) =>
      recolorSharedCustomGroup(
        groupId,
        customGroups.find((group) => group.id === groupId)?.label ?? groupId,
        colorId,
      ),
    [customGroups, recolorSharedCustomGroup],
  );

  const projectLabelFor = useCallback(
    (environmentId: string, projectId: string) =>
      projects.find(
        (project) => project.environmentId === environmentId && project.id === projectId,
      )?.title ?? null,
    [projects],
  );
  // This is the one place on the phone where sessions from several machines mix.
  const environmentAppearances = useEnvironmentAppearances();
  const environmentLabelFor = useCallback(
    (environmentId: string) => environmentAppearances.get(environmentId)?.name ?? null,
    [environmentAppearances],
  );
  const environmentAppearanceFor = useCallback(
    (environmentId: string) => environmentAppearances.get(environmentId) ?? null,
    [environmentAppearances],
  );
  const openEnvironmentAppearance = useCallback(
    (environmentId: EnvironmentId) => {
      // The sheet is a Modal; a formSheet pushed underneath it would be hidden.
      setSheet(null);
      navigation.navigate("EnvironmentAppearance", { environmentId });
    },
    [navigation],
  );

  const handleSelect = useCallback(
    (row: PhaseSidebarRow) => {
      markVisited(`${row.thread.environmentId}:${row.thread.id}`);
      props.onSelectThread(row.thread);
    },
    [markVisited, props],
  );

  const handleRowAction = useCallback(
    (row: PhaseSidebarRow, actionId: string) => {
      const thread = row.thread;
      const threadKey = `${thread.environmentId}:${thread.id}`;

      if (actionId.startsWith("priority:")) {
        const parsed = Number.parseInt(actionId.slice("priority:".length), 10);
        const priority = PHASE_SIDEBAR_PRIORITY_CHOICES.find(
          (choice) => choice.value === parsed,
        )?.value;
        if (priority === undefined) return;
        void updateThreadMetadata({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, priority },
        });
        return;
      }
      if (actionId.startsWith("snooze:")) {
        const selection = resolveThreadListV2SnoozeMenuSelection({
          event: actionId,
          displayedPresets: resolveSnoozePresets(new Date()),
          now: new Date(),
        });
        if (selection._tag === "selected") {
          void snoozeThread(thread, selection.preset.snoozedUntil);
        } else if (selection._tag === "expired") {
          Alert.alert(
            "Could not snooze thread",
            "That snooze time has passed. Choose another time.",
          );
        }
        return;
      }
      if (actionId === "group:new") {
        setSheet({ kind: "group", intent: { kind: "create", seedThreadKey: threadKey } });
        return;
      }
      if (actionId === "group:none") {
        setThreadCustomGroup(thread, null);
        return;
      }
      if (actionId.startsWith("group:")) {
        const groupId = actionId.slice("group:".length);
        const label = customGroups.find((group) => group.id === groupId)?.label ?? groupId;
        setThreadCustomGroup(thread, label);
        return;
      }

      switch (actionId) {
        case "people":
          navigation.navigate("ThreadMembers", {
            environmentId: thread.environmentId,
            threadId: thread.id,
          });
          return;
        case "mark-read":
          markVisited(threadKey);
          return;
        case "mark-unread":
          clearVisit(threadKey);
          return;
        case "settle":
          void settleThread(thread);
          return;
        case "unsettle":
          void unsettleThread(thread);
          return;
        case "snooze":
          // The bare item only appears when no presets were offered; an hour
          // is the shortest preset the stock list has.
          void snoozeThread(thread, new Date(Date.now() + 60 * 60_000).toISOString());
          return;
        case "unsnooze":
          void unsnoozeThread(thread);
          return;
        case "pin":
          void pinThread(thread);
          return;
        case "unpin":
          void unpinThread(thread);
          return;
        case "archive":
          archiveThread(thread);
          return;
        case "delete":
          confirmDeleteThread(thread);
          return;
        case "force-stop":
          void stopSession({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          });
          return;
      }
    },
    [
      archiveThread,
      clearVisit,
      confirmDeleteThread,
      customGroups,
      markVisited,
      navigation,
      pinThread,
      setThreadCustomGroup,
      settleThread,
      snoozeThread,
      stopSession,
      unpinThread,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  // Reordering never reaches here: the list owns it (see PhaseSidebarList).
  const handleSectionAction = useCallback(
    (section: PhaseSidebarSection, actionId: PhaseSidebarSectionActionId) => {
      switch (actionId) {
        case "rename":
          setSheet({
            kind: "group",
            intent: { kind: "rename", groupId: section.id, label: section.label },
          });
          return;
        case "move-up":
        case "move-down":
          return;
        case "color:default":
          recolorCustomGroup(section.id, null);
          return;
        case "delete":
          Alert.alert(
            "Delete group?",
            `“${section.label}” will be removed for everyone. Its sessions go back to Ungrouped; nothing is deleted.`,
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () => deleteCustomGroup(section.id),
              },
            ],
          );
          return;
        default:
          if (actionId.startsWith("color:")) {
            recolorCustomGroup(section.id, actionId.slice("color:".length));
          }
          return;
      }
    },
    [deleteCustomGroup, recolorCustomGroup],
  );
  // "New group…" from a row files that row; from the sheet it is an empty
  // group until a session is moved in. Either way it is registered on a host
  // that keeps shared groups; without one, the empty group is a device-local
  // placeholder, as before.
  const createCustomGroup = useCallback(
    (label: string, seedThreadKey: string | null) => {
      const sharedId = createSharedCustomGroup(label);
      if (sharedId !== null) {
        updateGrouping((current) => rememberPhaseSidebarCustomGroupOrder(current, sharedId));
      }
      const seed =
        seedThreadKey === null
          ? null
          : rows.find((row) => `${row.thread.environmentId}:${row.thread.id}` === seedThreadKey);
      if (seed) setThreadCustomGroup(seed.thread, label);
      else if (sharedId === null)
        updateGrouping((current) => createPhaseSidebarCustomGroup(current, { label }).preferences);
    },
    [createSharedCustomGroup, rows, setThreadCustomGroup, updateGrouping],
  );
  const moveCustomGroup = useCallback(
    (orderedIds: ReadonlyArray<string>, id: string, direction: "up" | "down") =>
      updateGrouping((current) => movePhaseSidebarCustomGroup(current, orderedIds, id, direction)),
    [updateGrouping],
  );

  const handleReparent = useCallback(
    (subject: PhaseSidebarRow, parent: PhaseSidebarRow | null) => {
      // Same command web's setThreadParent uses; the drop was already validated
      // against cycles and the depth limit before it got here.
      void updateThreadMetadata({
        environmentId: subject.thread.environmentId,
        input: {
          threadId: subject.thread.id,
          parentThreadId: parent === null ? null : parent.thread.id,
        },
      });
    },
    [updateThreadMetadata],
  );

  const handleReorder = useCallback(
    (subject: PhaseSidebarRow, before: PhaseSidebarRow) => {
      // Direction comes from the pin ORDER (`pinOrderKey`, the sortable key the
      // server assigns), not `pinnedAt`, which is when the pin happened.
      // `moveThread` owns the fractional-index planning and moves one
      // position per call, so a long drag needs repeating.
      const subjectKey = subject.thread.pinOrderKey ?? "";
      const beforeKey = before.thread.pinOrderKey ?? "";
      void moveThread(subject.thread, subjectKey > beforeKey ? "up" : "down");
    },
    [moveThread],
  );

  // Status labels and controls get their own lines. This keeps every count
  // meaningful at large text instead of shrinking it back to a bare number.
  const listHeader = useMemo(
    () => (
      <View>
        <View className="px-4 pb-1 pt-2">
          <View className="flex-row items-start justify-between gap-3">
            <PhaseSidebarCounters rows={rows} />
          </View>
          <View className="mt-2 flex-row items-center justify-end gap-2">
            <HeaderButton
              active={sheet?.kind === "group"}
              icon="square.grid.2x2"
              label={PHASE_SIDEBAR_GROUP_BY_LABELS[grouping.groupBy]}
              onPress={() =>
                setSheet((current) =>
                  current?.kind === "group" ? null : { kind: "group", intent: { kind: "browse" } },
                )
              }
            />
            <HeaderButton
              active={sheet?.kind === "filter" || phaseSidebarFiltersActive(filters)}
              icon="line.3.horizontal.decrease"
              label="Filter"
              onPress={() =>
                setSheet((current) => (current?.kind === "filter" ? null : { kind: "filter" }))
              }
            />
          </View>
        </View>
      </View>
    ),
    [filters, grouping.groupBy, rows, sheet?.kind],
  );

  return (
    <View className="flex-1">
      <PhaseSidebarSheetModal onClose={() => setSheet(null)} visible={sheet !== null}>
        {sheet?.kind === "filter" ? (
          <PhaseSidebarFilterSheet
            filters={filters}
            groups={customGroups}
            onChangeFilters={setFilters}
            onChangeSort={setSort}
            onClose={() => setSheet(null)}
            projects={projects}
            rows={rows}
            sort={sort}
          />
        ) : sheet?.kind === "group" ? (
          <PhaseSidebarGroupBySheet
            environments={environmentAppearances}
            grouping={grouping}
            groups={customGroups}
            intent={sheet.intent}
            onChange={updateGrouping}
            onClose={() => setSheet(null)}
            onCreateGroup={createCustomGroup}
            onDeleteGroup={deleteCustomGroup}
            onMoveGroup={moveCustomGroup}
            onOpenEnvironment={openEnvironmentAppearance}
            {...(canRecolorCustomGroups ? { onRecolorGroup: recolorCustomGroup } : {})}
            onRenameGroup={renameCustomGroup}
          />
        ) : null}
      </PhaseSidebarSheetModal>
      <PhaseSidebarList
        ListEmptyComponent={
          <View className="items-center gap-2 px-6 py-12">
            <Text className="text-center text-sm text-foreground-muted">
              {phaseSidebarFiltersActive(filters) || props.homeFilters.searchQuery.trim().length > 0
                ? "No sessions match these filters."
                : "No sessions yet."}
            </Text>
          </View>
        }
        ListHeaderComponent={listHeader}
        activeThreadKey={props.selectedThreadKey}
        contentContainerStyle={props.contentContainerStyle}
        contentInsetAdjustmentBehavior={props.contentInsetAdjustmentBehavior}
        canRecolorGroups={canRecolorCustomGroups}
        customGroupRegistry={sharedCustomGroups}
        drafts={drafts}
        environmentAppearanceFor={environmentAppearanceFor}
        environmentLabelFor={environmentLabelFor}
        filters={filters}
        grouping={grouping}
        onChangeGrouping={updateGrouping}
        onReorderRow={handleReorder}
        onReparentRow={handleReparent}
        onRowAction={handleRowAction}
        onSectionAction={handleSectionAction}
        onSelectRow={handleSelect}
        projectLabelFor={projectLabelFor}
        renderDraftRow={renderDraftRow}
        rows={rows}
        sort={sort}
        viewerUserId={viewerUserId}
      />
    </View>
  );
}
