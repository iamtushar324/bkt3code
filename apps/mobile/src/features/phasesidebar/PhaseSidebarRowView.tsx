// T3-CUSTOM(expbkt3): one thread row in the mobile phase sidebar.
//
// The metadata lane is the whole point of this sidebar, so it carries the same
// facts as web: repository, worktree codename, Linear tags, Mattermost mark, PR
// number, priority, owner, provider and relative time. Every one of those is
// resolved by client-runtime; this component only lays them out.
//
// Interaction matches the stock thread list exactly, because that is what a
// thumb already knows: tap opens, hold opens the menu, swipe left reveals the
// lifecycle action (Settle / Reopen), Snooze and Archive, and a full swipe
// commits the lifecycle action.
//
// Colour classes are the mobile theme's tokens (`text-foreground-muted`,
// `bg-subtle`, ...). Web's `text-muted-foreground` family does not exist here
// and silently renders as black in dark mode.
import {
  formatThreadPriority,
  // T3-CUSTOM(expbkt3): running subagents and "Working 4m", as on web.
  phaseSidebarActiveSubagentCount,
  phaseSidebarRowOwnerAvatarUserId,
  phaseSidebarSubagentCountLabel,
  phaseSidebarWorktreeRowProps,
  resolvePhaseSidebarMattermostLink,
  resolvePhaseSidebarProviderCode,
  resolvePhaseSidebarWorkingStatus,
  type PhaseSidebarRow,
  type PhaseSidebarWorktreeView,
} from "@t3tools/client-runtime/state/phase-sidebar";
import { worktreeCodenameToneIndex } from "@t3tools/shared/worktreeCodename";
import type { LinearIssueStatusSummary, UserId } from "@t3tools/contracts";
import {
  MenuView,
  type MenuAction,
  type MenuComponentRef,
  type NativeActionEvent,
} from "@react-native-menu/menu";
import { memo, useCallback, useMemo, useRef, type ReactNode, type RefObject } from "react";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { EnvironmentBadge } from "../environments/EnvironmentBadge";
import type { MobileEnvironmentAppearance } from "../environments/environmentAppearance";
import { PhaseSidebarRowStatus } from "./PhaseSidebarRowStatus";
import { PhaseSidebarRowWorkingLabel } from "./PhaseSidebarRowWorkingLabel";
// T3-CUSTOM(expbkt3): Linear tags on a session.
import {
  phaseSidebarLinearChipLabel,
  phaseSidebarLinearTagKinds,
  phaseSidebarLinearTagMenuTitle,
  resolvePhaseSidebarLinearTags,
  type PhaseSidebarLinearTag,
  type PhaseSidebarLinearTagKind,
} from "./phaseSidebarLinearTags";
import {
  phaseSidebarCheckoutToneClassName,
  phaseSidebarPriorityToneClassName,
} from "./phaseSidebarRowTone";

/** What a swipe on this row does; resolved by the list from the row model. */
export interface PhaseSidebarRowSwipe {
  readonly primary: "settle" | "unsettle" | "archive" | "unsnooze";
  /** Snooze presets to offer from the swipe's secondary action; null hides it. */
  readonly snoozeMenu: MenuAction[] | null;
  /** Archive as a third button; false when the primary already IS archive. */
  readonly archive: boolean;
}

export interface PhaseSidebarRowViewProps {
  readonly row: PhaseSidebarRow;
  /** Whose avatar to omit: the row shows only *other* people's. */
  readonly viewerUserId: UserId | null;
  readonly worktreeView: PhaseSidebarWorktreeView;
  /**
   * Which machine this session runs on. The list supplies it only when the rows
   * on screen span more than one environment, so a single-remote phone stays
   * uncluttered.
   */
  readonly environmentAppearance?: MobileEnvironmentAppearance | null;
  readonly indentDepth: number;
  readonly isActive: boolean;
  readonly subtreeCount: number;
  readonly isExpanded: boolean;
  /** This row's own Linear issue statuses; they tell sub-issues apart. */
  readonly linearStatuses: ReadonlyArray<LinearIssueStatusSummary>;
  /** Relative age ("2h") or, for a snoozed row, when it wakes. */
  readonly timeLabel: string;
  /**
   * T3-CUSTOM(expbkt3): replace the time label with "Working 4m" while the row
   * works. False on the snoozed shelf, whose time label is the wake time.
   */
  readonly showWorkingStatus?: boolean;
  readonly onPress: (row: PhaseSidebarRow) => void;
  /** Mutable because MenuView's prop type is not readonly. */
  readonly actions: MenuAction[];
  readonly onPressAction: (row: PhaseSidebarRow, actionId: string) => void;
  readonly swipe: PhaseSidebarRowSwipe;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  /** Reports this row's box so a drop can be resolved without measuring. */
  readonly onLayoutGeometry?: (key: string, y: number, height: number, depth: number) => void;
  readonly rowKey: string;
  readonly isDragging?: boolean;
  readonly isDropTarget?: boolean;
  readonly dropRejectionLabel?: string | null;
  /**
   * The grab affordance, supplied by the list because it owns the gesture.
   * Only pinned rows get one — they are the rows whose order is the user's.
   */
  readonly dragHandle?: ReactNode;
  readonly onToggleExpanded: (row: PhaseSidebarRow) => void;
}

/** One indent step, kept small: a phone has no horizontal room to spare. */
const INDENT_STEP = 14;

const PRIMARY_SWIPE: Record<
  PhaseSidebarRowSwipe["primary"],
  {
    readonly icon: "checkmark" | "arrow.uturn.backward" | "archivebox" | "clock";
    readonly label: string;
  }
> = {
  settle: { icon: "checkmark", label: "Settle" },
  unsettle: { icon: "arrow.uturn.backward", label: "Reopen" },
  archive: { icon: "archivebox", label: "Archive" },
  unsnooze: { icon: "clock", label: "Wake" },
};

type IdentifiedMenuAction = MenuAction & { readonly id: string };

/** One glyph per Linear tag kind, so a project, an issue and a sub-issue read apart. */
const LINEAR_TAG_ICON: Record<PhaseSidebarLinearTagKind, AppSymbolName> = {
  project: "cube",
  issue: "ticket",
  "sub-issue": "arrow.turn.down.right",
};

function openLinearTag(tag: PhaseSidebarLinearTag) {
  void tryOpenExternalUrl(tag.url, "linear-link").then((opened) => {
    if (!opened) Alert.alert("Unable to open Linear", "The Linear link could not be opened.");
  });
}

export const PhaseSidebarRowView = memo(function PhaseSidebarRowView(
  props: PhaseSidebarRowViewProps,
) {
  const { row, worktreeView, onPressAction } = props;
  const thread = row.thread;
  const unread = row.isUnreadCompletion;
  const { width: windowWidth } = useWindowDimensions();
  const screenColor = String(useUniwindTheme()["--color-screen"]);
  const worktree = phaseSidebarWorktreeRowProps(worktreeView, thread.worktreePath);
  const { linearStatuses } = props;
  const linearTags = useMemo(
    () =>
      row.linearIssueSupported
        ? resolvePhaseSidebarLinearTags(
            { branch: thread.branch, linearLinks: thread.linearLinks },
            linearStatuses,
          )
        : [],
    [linearStatuses, row.linearIssueSupported, thread.branch, thread.linearLinks],
  );
  const mattermost = row.mattermostLinkSupported
    ? resolvePhaseSidebarMattermostLink(thread.mattermostThreadUrl)
    : null;
  const ownerAvatarUserId = phaseSidebarRowOwnerAvatarUserId({
    ownerUserId: thread.ownerUserId,
    currentUserId: props.viewerUserId,
  });
  const providerCode = resolvePhaseSidebarProviderCode(row.providerKind);
  const priority = thread.priority ?? null;
  // T3-CUSTOM(expbkt3): BEGIN — upstream's working rule and the native
  // subagents the thread runs now; both read the same way on web.
  const workingStatus =
    props.showWorkingStatus === false ? null : resolvePhaseSidebarWorkingStatus(thread);
  const activeSubagentCount = phaseSidebarActiveSubagentCount(thread);
  const subagentCountLabel = phaseSidebarSubagentCountLabel(activeSubagentCount);
  // T3-CUSTOM(expbkt3): END
  const actionsMenuRef = useRef<MenuComponentRef>(null);
  const linearMenuRef = useRef<MenuComponentRef>(null);
  // T3-CUSTOM(expbkt3): one tag opens at once; several open a list to pick from,
  // the same native menu the row's own actions use.
  const linearMenuActions = useMemo<MenuAction[]>(
    () =>
      linearTags.map((tag, index) => ({
        id: String(index),
        title: phaseSidebarLinearTagMenuTitle(tag),
      })),
    [linearTags],
  );
  const handleLinearMenuAction = useCallback(
    (event: NativeActionEvent) => {
      const tag = linearTags[Number(event.nativeEvent.event)];
      if (tag !== undefined) openLinearTag(tag);
    },
    [linearTags],
  );
  const handleLinearPress = useCallback(() => {
    const only = linearTags.length === 1 ? linearTags[0] : undefined;
    if (only !== undefined) {
      openLinearTag(only);
      return;
    }
    if (Platform.OS !== "ios") {
      linearMenuRef.current?.show();
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: linearTags.length,
        options: [...linearTags.map(phaseSidebarLinearTagMenuTitle), "Cancel"],
        title: "Open in Linear",
      },
      (selectedIndex) => {
        const tag = linearTags[selectedIndex];
        if (tag !== undefined) openLinearTag(tag);
      },
    );
  }, [linearTags]);

  const handlePress = useCallback(() => props.onPress(row), [props, row]);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      props.onLayoutGeometry?.(props.rowKey, y, height, props.indentDepth);
    },
    [props],
  );
  const handlePressAction = useCallback(
    (event: NativeActionEvent) => onPressAction(row, event.nativeEvent.event),
    [onPressAction, row],
  );
  const handleToggle = useCallback(() => props.onToggleExpanded(row), [props, row]);
  // VoiceOver custom actions cannot enter a submenu, so expose the actionable
  // leaves (for example each snooze preset and destination group) directly.
  const actionLeaves = useMemo<ReadonlyArray<IdentifiedMenuAction>>(
    () =>
      props.actions
        .flatMap((action) => action.subactions ?? [action])
        .filter((action): action is IdentifiedMenuAction => typeof action.id === "string"),
    [props.actions],
  );
  const accessibilityActions = useMemo(
    () =>
      actionLeaves.map((action) => ({
        name: action.id,
        label: action.title,
      })),
    [actionLeaves],
  );
  const showActions = useCallback(() => actionsMenuRef.current?.show(), []);
  // T3-CUSTOM(expbkt3): iOS has no accessible MenuView child, so retain nested
  // lifecycle groups in successive native action sheets instead of flattening them.
  const presentIosActions = useCallback(
    (actions: ReadonlyArray<IdentifiedMenuAction>, title: string) => {
      const cancelButtonIndex = actions.length;
      ActionSheetIOS.showActionSheetWithOptions(
        {
          cancelButtonIndex,
          destructiveButtonIndex: actions.flatMap((action, index) =>
            action.attributes?.destructive === true ? [index] : [],
          ),
          options: [...actions.map((action) => action.title), "Cancel"],
          title,
        },
        (selectedIndex) => {
          const action = actions[selectedIndex];
          if (action === undefined) return;
          const subactions = action.subactions?.filter(
            (candidate): candidate is IdentifiedMenuAction => typeof candidate.id === "string",
          );
          if (subactions && subactions.length > 0) {
            presentIosActions(subactions, thread.title + " · " + action.title);
            return;
          }
          onPressAction(row, action.id);
        },
      );
    },
    [onPressAction, row, thread.title],
  );
  const iosTopLevelActions = useMemo<ReadonlyArray<IdentifiedMenuAction>>(() => {
    const priorityActions = props.actions.filter(
      (action): action is IdentifiedMenuAction =>
        typeof action.id === "string" && action.id.startsWith("priority:"),
    );
    const nonPriorityActions = props.actions.filter(
      (action): action is IdentifiedMenuAction =>
        typeof action.id === "string" && !action.id.startsWith("priority:"),
    );
    return priorityActions.length === 0
      ? nonPriorityActions
      : [
          ...nonPriorityActions,
          {
            id: "priority",
            subactions: [...priorityActions],
            title: "Priority",
          },
        ];
  }, [props.actions]);
  const showLongPressActions = useCallback(() => {
    // `@react-native-menu/menu` exposes an imperative menu presenter on
    // Android only. iOS keeps the familiar long-press gesture with a native
    // action sheet while the visible overflow retains its hierarchical menu.
    if (Platform.OS !== "ios") {
      showActions();
      return;
    }
    presentIosActions(iosTopLevelActions, thread.title + " actions");
  }, [iosTopLevelActions, presentIosActions, showActions, thread.title]);

  const primary = PRIMARY_SWIPE[props.swipe.primary];
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `${primary.label} ${thread.title}`,
      icon: primary.icon,
      label: primary.label,
      onPress: () => onPressAction(row, props.swipe.primary),
    }),
    [onPressAction, primary, props.swipe.primary, row, thread.title],
  );
  const snoozeMenu = props.swipe.snoozeMenu;
  const secondaryAction = useMemo(
    () =>
      snoozeMenu === null
        ? null
        : {
            accessibilityLabel: `Choose when to snooze ${thread.title}`,
            icon: "clock" as const,
            label: "Snooze",
            menu: {
              actions: snoozeMenu,
              onPressAction: handlePressAction,
              title: "Snooze until",
            },
            onPress: () => undefined,
          },
    [handlePressAction, snoozeMenu, thread.title],
  );
  const tertiaryAction = useMemo(
    () =>
      props.swipe.archive
        ? {
            accessibilityLabel: `Archive ${thread.title}`,
            icon: "archivebox" as const,
            label: "Archive",
            onPress: () => onPressAction(row, "archive"),
          }
        : null,
    [onPressAction, props.swipe.archive, row, thread.title],
  );
  const handleDelete = useCallback(() => onPressAction(row, "delete"), [onPressAction, row]);

  const swipeHint = [
    primary.label.toLowerCase(),
    ...(secondaryAction === null ? [] : ["snooze"]),
    ...(tertiaryAction === null ? [] : ["archive"]),
  ].join(", ");

  return (
    <ThreadSwipeable
      backgroundColor={screenColor}
      // T3-CUSTOM(expbkt3): upstream added threadKey so a swipe row can register
      // its dismissal; same environment:thread form the other thread lists use.
      threadKey={`${thread.environmentId}:${thread.id}`}
      compactActions
      enableTrackpadSwipe
      fullSwipeAction="primary"
      fullSwipeWidth={windowWidth - 32}
      onDelete={handleDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={primaryAction}
      resetKey={props.rowKey}
      secondaryAction={secondaryAction}
      tertiaryAction={tertiaryAction}
      threadTitle={thread.title}
    >
      {(close) => (
        <View
          className={cn(
            "min-h-[56px] flex-row items-stretch gap-1 bg-screen py-2.5 pr-2",
            props.isActive && "bg-primary/10",
            props.isDragging === true && "opacity-40",
            props.isDropTarget === true &&
              (props.dropRejectionLabel === null ? "bg-emerald-500/15" : "bg-rose-500/15"),
          )}
          onLayout={handleLayout}
          style={{ paddingLeft: 16 + props.indentDepth * INDENT_STEP }}
        >
          <Pressable
            accessibilityActions={accessibilityActions}
            accessibilityHint={`Opens the thread. Swipe left for ${swipeHint}. Touch and hold for actions.`}
            accessibilityLabel={`${thread.title}${unread ? ", unread" : ""}${props.environmentAppearance ? `, on ${props.environmentAppearance.name}` : ""}`}
            accessibilityRole="button"
            accessibilityState={{ selected: props.isActive }}
            className="min-w-0 flex-1 flex-row items-start gap-2"
            onAccessibilityAction={({ nativeEvent }) => onPressAction(row, nativeEvent.actionName)}
            onLongPress={showLongPressActions}
            onPress={() => {
              close();
              handlePress();
            }}
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            {/* The unread dot sits in a fixed gutter, so read and unread
                titles start at the same x and the eye can scan the column. */}
            <View className="mt-[7px] h-2 w-2 shrink-0 items-center justify-center">
              {unread ? <View className="h-2 w-2 rounded-full bg-sky-500" /> : null}
            </View>

            {props.subtreeCount > 0 ? (
              <Pressable
                className="mt-0.5 flex-row items-center gap-0.5"
                hitSlop={8}
                onPress={handleToggle}
              >
                <Text className="font-t3-mono text-[11px] text-foreground-muted">
                  {props.isExpanded ? "⌄" : "›"}
                </Text>
                <Text className="font-t3-mono text-[11px] text-foreground-muted">
                  {props.subtreeCount}
                </Text>
              </Pressable>
            ) : null}

            <View className="min-w-0 flex-1">
              <View className="flex-row items-baseline gap-2">
                <Text
                  className={cn(
                    "min-w-0 flex-1 text-[15px] leading-5",
                    unread
                      ? "font-t3-bold text-foreground"
                      : "font-t3-medium text-foreground-muted",
                  )}
                  numberOfLines={2}
                >
                  {thread.title}
                </Text>
                {/* T3-CUSTOM(expbkt3): provider-native subagents running now, in
                    the subtree counter's style, whether the row is open or not. */}
                {subagentCountLabel === null ? null : (
                  <View
                    accessibilityLabel={subagentCountLabel}
                    className="shrink-0 flex-row items-center gap-0.5 self-center"
                  >
                    <SymbolView name="cpu" size={10} tintColor="#0ea5e9" type="monochrome" />
                    <Text className="font-t3-mono text-[11px] tabular-nums text-adaptive-sky-600-400">
                      {activeSubagentCount}
                    </Text>
                  </View>
                )}
                <PhaseSidebarRowStatus row={row} />
                {workingStatus === null ? (
                  <Text
                    className={cn(
                      "shrink-0 font-t3-mono text-[11px] tabular-nums",
                      unread ? "text-adaptive-sky-600-400" : "text-foreground-tertiary",
                    )}
                  >
                    {props.timeLabel}
                  </Text>
                ) : (
                  <PhaseSidebarRowWorkingLabel status={workingStatus} />
                )}
              </View>

              {/* The metadata lane. Order matches web so the two read the same. */}
              <View className="mt-1 flex-row items-center gap-2">
                {props.environmentAppearance ? (
                  <EnvironmentBadge appearance={props.environmentAppearance} variant="glyph" />
                ) : null}
                <Text
                  className="shrink font-t3-mono text-[11px] text-foreground-muted"
                  numberOfLines={1}
                >
                  {row.repositoryLabel}
                </Text>
                {worktree.worktreeCodename === null ? null : (
                  <Text
                    className={cn(
                      "shrink-0 font-t3-mono text-[11px]",
                      phaseSidebarCheckoutToneClassName(
                        worktreeCodenameToneIndex(worktree.worktreeCodename),
                      ),
                    )}
                    numberOfLines={1}
                  >
                    {worktree.worktreeCodename}
                    {worktree.worktreeSharedCount > 0 ? ` ×${worktree.worktreeSharedCount}` : ""}
                  </Text>
                )}
                {linearTags.length === 0 ? null : (
                  <LinearTagChip
                    menuActions={linearMenuActions}
                    menuRef={linearMenuRef}
                    onPress={handleLinearPress}
                    onPressMenuAction={handleLinearMenuAction}
                    tags={linearTags}
                  />
                )}
                {mattermost === null ? null : (
                  <Text className="shrink-0 font-t3-mono text-[11px] text-adaptive-sky-700-300">
                    mm
                  </Text>
                )}

                <View className="flex-1" />

                {priority === null || !row.prioritySupported ? null : (
                  <Text
                    className={cn(
                      "shrink-0 overflow-hidden rounded px-1 font-t3-mono text-[11px]",
                      phaseSidebarPriorityToneClassName(priority),
                    )}
                  >
                    {formatThreadPriority(priority)}
                  </Text>
                )}
                {ownerAvatarUserId === null ? null : (
                  <View className="h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary/70">
                    <Text className="font-t3-mono text-[8px] text-primary-foreground">
                      {ownerAvatarUserId.slice(0, 1).toUpperCase()}
                    </Text>
                  </View>
                )}
                <Text className="shrink-0 font-t3-mono text-[11px] uppercase text-foreground-tertiary">
                  {providerCode}
                </Text>
              </View>
            </View>
          </Pressable>
          {/* T3-CUSTOM(expbkt3): MenuView swallows its child from iOS accessibility.
              ActionSheetIOS leaves this visible control independently actionable. */}
          {Platform.OS === "ios" ? (
            <Pressable
              accessibilityHint="Opens session lifecycle actions"
              accessibilityLabel={`Actions for ${thread.title}`}
              accessibilityRole="button"
              className="w-8 items-center justify-center rounded-md"
              onPress={showLongPressActions}
            >
              <SymbolView
                name="ellipsis"
                size={16}
                tintColorClassName="accent-icon"
                type="monochrome"
              />
            </Pressable>
          ) : (
            <MenuView
              actions={props.actions}
              isAnchoredToRight
              onPressAction={handlePressAction}
              ref={actionsMenuRef}
              title={`${thread.title} actions`}
            >
              <Pressable
                accessibilityHint="Opens session lifecycle actions"
                accessibilityLabel={`Actions for ${thread.title}`}
                accessibilityRole="button"
                className="w-8 items-center justify-center rounded-md"
                onPress={showActions}
              >
                <SymbolView
                  name="ellipsis"
                  size={16}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                />
              </Pressable>
            </MenuView>
          )}
          {props.dragHandle}
        </View>
      )}
    </ThreadSwipeable>
  );
});

/**
 * T3-CUSTOM(expbkt3): the row's Linear chip: one glyph per kind present, the
 * lead tag's key, and "+N" for the rest. Android needs the MenuView mounted to
 * show the pick list; iOS uses an action sheet, as the row's actions do.
 */
function LinearTagChip(props: {
  readonly tags: ReadonlyArray<PhaseSidebarLinearTag>;
  readonly menuActions: MenuAction[];
  readonly menuRef: RefObject<MenuComponentRef | null>;
  readonly onPress: () => void;
  readonly onPressMenuAction: (event: NativeActionEvent) => void;
}) {
  const { tags } = props;
  const label = phaseSidebarLinearChipLabel(tags);
  const chip = (
    <Pressable
      accessibilityHint={tags.length > 1 ? "Lists the Linear tags to open" : "Opens in Linear"}
      accessibilityLabel={`Linear: ${tags.map(phaseSidebarLinearTagMenuTitle).join(", ")}`}
      accessibilityRole="button"
      className="shrink flex-row items-center gap-0.5"
      hitSlop={6}
      onPress={props.onPress}
    >
      {phaseSidebarLinearTagKinds(tags).map((kind) => (
        <SymbolView
          key={kind}
          name={LINEAR_TAG_ICON[kind]}
          size={10}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ))}
      <Text className="shrink font-t3-mono text-[11px] text-foreground-muted" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
  if (Platform.OS === "ios" || tags.length < 2) return chip;
  return (
    <MenuView
      actions={props.menuActions}
      onPressAction={props.onPressMenuAction}
      ref={props.menuRef}
      title="Open in Linear"
    >
      {chip}
    </MenuView>
  );
}
