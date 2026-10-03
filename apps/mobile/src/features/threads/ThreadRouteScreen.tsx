import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useWorktreeSetup } from "./use-worktree-setup";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenHeaderButton } from "../../components/ScreenHeaderButton";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Option from "effect/Option";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
// T3-CUSTOM(expbkt3): Pressable — stale deep links need an in-route escape to the thread list.
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionsReady } from "../../state/workspace";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { recoverFailedThreadDraft } from "../../state/recover-failed-thread-draft";
// T3-CUSTOM(expbkt3): phase sidebar read state.
import { useMarkPhaseSidebarThreadVisited } from "../phasesidebar/phaseSidebarVisitStore";
// T3-CUSTOM(expbkt3): report the open thread for user presence.
import { useThreadPresenceScope } from "../presence/useThreadPresenceScope";
// T3-CUSTOM(expbkt3): per-thread API-level cost.
import { useThreadUsage } from "../threadusage/useThreadUsage";
import { useEnvironmentQuery } from "../../state/query";
import { dismissGitActionResult, useGitActionProgress } from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";
import { sourceControlEnvironment } from "../../state/sourceControl";

import { EmptyState } from "../../components/EmptyState";
// T3-CUSTOM(expbkt3): the unavailable-thread escape button label.
import { AppText as Text } from "../../components/AppText";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";
import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
// T3-CUSTOM(expbkt3): plan review entry point.
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";
// T3-CUSTOM(expbkt3): compact headers keep Git utilities; the cost pill leads them.
import { useThreadGitCenterHeaderItems, useThreadGitCompactHeaderItems } from "./ThreadGitControls";
// T3-CUSTOM(expbkt3): smart git action asks the agent (features/smartgit).
import { useSmartGitAction } from "../smartgit/useSmartGitAction";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../state/use-selected-thread-git-state";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { threadEnvironment } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";
import { threadRouteIsHydrating } from "./thread-route-hydration";

function ThreadHeader(
  props: Parameters<typeof useThreadHeaderOptions>[0] & {
    readonly hasThreadCwd: boolean;
    readonly hasWorkspaceRoot: boolean;
    readonly fileInspectorSupported: boolean;
    readonly inspectorMode: ThreadInspectorMode | null;
    readonly onToggleInspector: () => void;
    readonly onOpenGitInspector: () => void;
    readonly onOpenFilesInspector: () => void;
    // T3-CUSTOM(expbkt3): per-thread API-level cost pill.
    readonly threadCostHeader: { readonly label: string; readonly onPress: () => void } | null;
  },
) {
  const navigation = useNavigation();
  const { layout, panes, toggleAuxiliaryPane } = useAdaptiveWorkspaceLayout();
  const { onOpenTerminal, onMergeBack } = props.gitControls;
  const native = useThreadHeaderOptions(props);
  // T3-CUSTOM(expbkt3): smart git — Android's header button, and a header refresh key on iOS.
  const smartGit = useSmartGitAction(props.gitControls);
  // T3-CUSTOM(expbkt3): BEGIN — the cost pill sits ahead of the git controls,
  // and compact headers keep title and environment readable while the Git menu
  // retains the secondary utility access routes.
  const forkCenterHeaderItems = useThreadGitCenterHeaderItems(props.gitControls);
  const forkCompactHeaderItems = useThreadGitCompactHeaderItems(props.gitControls);
  const threadCostHeaderItems = useMemo<ReadonlyArray<Record<string, unknown>>>(
    () =>
      props.threadCostHeader
        ? [
            {
              accessibilityLabel: `Session cost ${props.threadCostHeader.label}`,
              icon: { name: "dollarsign.circle", type: "sfSymbol" as const },
              identifier: "thread-right-cost",
              label: props.threadCostHeader.label,
              onPress: props.threadCostHeader.onPress,
              type: "button" as const,
            },
          ]
        : [],
    [props.threadCostHeader],
  );
  const nativeOptions =
    Platform.OS === "android"
      ? native.options
      : {
          ...native.options,
          unstable_headerRightItems: () => [
            ...threadCostHeaderItems,
            ...(layout.usesSplitView ? forkCenterHeaderItems : forkCompactHeaderItems),
          ],
        };
  // T3-CUSTOM(expbkt3): END
  const androidHeaderActions = useMemo<ReadonlyArray<ScreenHeaderAction>>(() => {
    const actions: ScreenHeaderAction[] = [];
    // T3-CUSTOM(expbkt3): BEGIN — the smart git action leads, so it stays a direct button.
    if (smartGit.visible) {
      actions.push({
        accessibilityLabel: `${smartGit.intent.label}: ask the agent`,
        icon: smartGit.icon,
        selected: smartGit.intent.highlighted,
        onPress: smartGit.run,
      });
    }
    // T3-CUSTOM(expbkt3): END
    // T3-CUSTOM(expbkt3): per-thread API-level cost.
    if (props.threadCostHeader) {
      actions.push({
        accessibilityLabel: `Session cost ${props.threadCostHeader.label}`,
        icon: "dollarsign.circle",
        onPress: props.threadCostHeader.onPress,
      });
    }
    if (props.onReturnToThread) {
      actions.push({
        accessibilityLabel: "Return to chat",
        icon: "chevron.left",
        onPress: props.onReturnToThread,
      });
    }
    if (props.hasThreadCwd) {
      const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
      actions.push({
        accessibilityLabel: filesVisible ? "Close files" : "Open files",
        selected: filesVisible,
        icon: "folder",
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      });
    }
    if (props.hasWorkspaceRoot) {
      actions.push({
        accessibilityLabel: "Open terminal",
        icon: "terminal",
        onPress: () => onOpenTerminal(null),
      });
    }
    actions.push({
      accessibilityLabel: "Open git controls",
      icon: "point.topleft.down.curvedto.point.bottomright.up",
      onPress: props.onOpenGitInspector,
    });
    if (onMergeBack) {
      actions.push({
        accessibilityLabel: "Merge back to source",
        icon: "arrow.triangle.merge",
        onPress: onMergeBack,
      });
    }
    return actions;
  }, [
    // T3-CUSTOM(expbkt3): smart git action.
    smartGit.visible,
    smartGit.intent.label,
    smartGit.intent.highlighted,
    smartGit.icon,
    smartGit.run,
    // T3-CUSTOM(expbkt3): per-thread cost pill.
    props.threadCostHeader,
    props.inspectorMode,
    panes.auxiliaryPaneVisible,
    props.onOpenFilesInspector,
    onOpenTerminal,
    onMergeBack,
    props.onOpenGitInspector,
    toggleAuxiliaryPane,
    props.onReturnToThread,
    props.hasThreadCwd,
    props.hasWorkspaceRoot,
  ]);

  return (
    <>
      <ScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        // T3-CUSTOM(expbkt3): fork right-side header items (cost pill, compact Git menu).
        options={nativeOptions}
        // T3-CUSTOM(expbkt3): re-apply header items when the cost label changes.
        // T3-CUSTOM(expbkt3): and when the smart git action changes.
        optionsVersion={[
          props.gitControls.projectScripts,
          props.threadCostHeader?.label,
          smartGit.headerVersion,
        ]}
        trailing={
          props.fileInspectorSupported && props.hasThreadCwd ? (
            <ScreenHeaderButton
              accessibilityLabel={
                props.inspectorMode !== null && panes.auxiliaryPaneVisible
                  ? "Hide inspector"
                  : "Show inspector"
              }
              icon="sidebar.right"
              selected={props.inspectorMode !== null && panes.auxiliaryPaneVisible}
              onPress={props.onToggleInspector}
            />
          ) : null
        }
        onBack={
          layout.usesSplitView
            ? undefined
            : () => {
                // A deep link or cold start has no previous route; Home is the way out.
                // Read the history at press time: it changes without re-rendering this screen.
                if (navigation.canGoBack()) navigation.goBack();
                else navigation.dispatch(StackActions.replace("Home"));
              }
        }
        actions={androidHeaderActions}
        hideBottomBorder
      />
      {native.fallback}
    </>
  );
}

interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function OpeningThreadLoadingScreen() {
  return <LoadingScreen message="Opening thread…" messagePlacement="above-spinner" />;
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}

/** Shows recovery only after the target route has reached a terminal unavailable state. */
function ThreadUnavailableScreen(props: {
  readonly actionLabel: string;
  readonly onAction: () => void;
  // T3-CUSTOM(expbkt3): a missing deep-linked thread keeps a visible route escape.
  readonly onGoToThreads: () => void;
}) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: "center",
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      className="bg-screen flex-1"
    >
      <EmptyState
        title="Thread unavailable"
        detail="This thread is not available in the current mobile snapshot."
        actionLabel={props.actionLabel}
        onAction={props.onAction}
      />
      {/* T3-CUSTOM(expbkt3): BEGIN give a missing deep-linked thread a visible route escape. */}
      <Pressable
        accessibilityHint="Returns to the threads list."
        accessibilityLabel="Go to threads list"
        accessibilityRole="button"
        className="mt-4 self-center rounded-lg bg-primary px-4 py-2.5 active:opacity-70"
        onPress={props.onGoToThreads}
      >
        <Text className="text-sm font-t3-bold text-primary-foreground">Go to threads</Text>
      </Pressable>
      {/* T3-CUSTOM(expbkt3): END give a missing deep-linked thread a visible route escape. */}
    </ScrollView>
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const connectionsReady = useConnectionsReady();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeEnvironmentShellState = useEnvironmentShellReadiness(environmentId);
  const { onReconnectEnvironment } = useRemoteConnections();
  const navigation = useNavigation();
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();

  if (environmentId === null || threadIdRaw === null) {
    return <OpeningThreadLoadingScreen />;
  }

  // Render the full thread chrome (header, feed, composer) as soon as the
  // thread SHELL is known — no blocking on message detail. The feed shows a
  // loading placeholder while messages fetch, the floating pill above the
  // composer reports loading/syncing, and the composer's connection pill
  // reports connecting/reconnecting status.
  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    return <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />;
  }

  const stillHydrating = threadRouteIsHydrating({
    isLoadingConnections: !connectionsReady,
    connectionState: routeConnectionState,
    shellStatus: routeEnvironmentShellState.status,
    shellHasError: routeEnvironmentShellState.hasError,
    detailStatus: selectedThreadDetailState.status,
    detailHasError: Option.isSome(selectedThreadDetailState.error),
  });

  if (stillHydrating) {
    return <OpeningThreadLoadingScreen />;
  }

  return (
    <ThreadUnavailableScreen
      actionLabel={
        routeEnvironmentRuntime === null ? "Manage environments" : "Reconnect environment"
      }
      onAction={() => {
        if (routeEnvironmentRuntime !== null) {
          onReconnectEnvironment(environmentId);
          return;
        }
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsEnvironments" },
        });
      }}
      // T3-CUSTOM(expbkt3): route escape back to the thread list.
      onGoToThreads={() => navigation.dispatch(StackActions.replace("Home"))}
    />
  );
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const { themeVariables } = useAppearancePreferences();
  const headerColor = themeVariables["--color-header"];
  const { fileInspector, layout, panes, showAuxiliaryPane, toggleAuxiliaryPane } =
    useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const {
    selectedThread,
    selectedThreadCreation,
    selectedThreadProject,
    selectedEnvironmentConnection,
  } = useThreadSelection();
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const composer = useThreadComposerState();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const requests = useSelectedThreadRequests();
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const historyControls = useMemo(() => {
    const history = selectedThreadDetailState.history;
    if (!selectedThread) {
      return undefined;
    }
    if (!history.hasMoreHistory && history.error === null) {
      return undefined;
    }
    return {
      hasMoreHistory: history.hasMoreHistory,
      loading: history.loading,
      error: history.error,
      onLoadEarlier: () => {
        void loadEarlierHistory({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id },
        });
      },
    };
  }, [loadEarlierHistory, selectedThread, selectedThreadDetailState.history]);
  const navigation = useNavigation();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const mergeBackTargetThreadId = resolveMergeBackTargetThreadId(selectedThreadDetail);
  const mergeBackRun =
    selectedThreadDetail === null ? null : resolveLatestMergeBackRun(selectedThreadDetail);
  const mergeBackBusyRef = useRef(false);
  const handleMergeBack = useCallback(async () => {
    if (
      mergeBackBusyRef.current ||
      !selectedThread ||
      mergeBackTargetThreadId === null ||
      mergeBackRun === null
    ) {
      return;
    }
    mergeBackBusyRef.current = true;
    try {
      const result = await mergeBack({
        environmentId: selectedThread.environmentId,
        input: {
          sourceThreadId: selectedThread.id,
          targetThreadId: mergeBackTargetThreadId,
          runId: mergeBackRun.id,
          creationSource: "mobile",
        },
      });
      if (result._tag !== "Success") return;
      navigation.navigate("Thread", {
        environmentId: selectedThread.environmentId,
        threadId: mergeBackTargetThreadId,
      });
    } finally {
      mergeBackBusyRef.current = false;
    }
  }, [mergeBack, mergeBackRun, mergeBackTargetThreadId, navigation, selectedThread]);
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  // T3-CUSTOM(expbkt3): BEGIN — opening a thread by any route (list, search,
  // notification, deep link) marks it read for the phase sidebar.
  const markPhaseSidebarVisited = useMarkPhaseSidebarThreadVisited();
  useEffect(() => {
    if (routeThreadIdentity !== null) markPhaseSidebarVisited(routeThreadIdentity);
    // Once per thread identity; the marker's own identity churns on every
    // preference write and must not re-stamp the visit.
  }, [routeThreadIdentity]);
  // T3-CUSTOM(expbkt3): END
  // T3-CUSTOM(expbkt3): report the open thread so agents can tell who is viewing it.
  useThreadPresenceScope(environmentId, threadId);
  const [inspectorSelection, setInspectorSelection] = useState<ThreadInspectorSelection | null>(
    () => (props.renderInspector ? { routeThreadIdentity, mode: "route" } : null),
  );
  const inspectorMode = (() => {
    if (inspectorSelection?.routeThreadIdentity === routeThreadIdentity) {
      if (inspectorSelection.mode === "files" && selectedThreadCwd === null) {
        return null;
      }
      return inspectorSelection.mode;
    }
    return null;
  })();
  useEffect(() => {
    if (
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  useEffect(() => {
    setInspectorSelection((current) => {
      if (props.renderInspector === undefined) {
        if (current === null || current.mode === "route") {
          return null;
        }
        return { ...current, routeThreadIdentity };
      }

      if (current === null || current.mode === "route") {
        return { routeThreadIdentity, mode: "route" };
      }

      return { ...current, routeThreadIdentity };
    });
  }, [props.renderInspector, routeThreadIdentity]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (props.renderInspector === undefined) {
          // Inspectors are contextual to this chat destination. Clear the
          // hidden chat copy after a native push so returning from Files,
          // Review, or Terminal cannot reserve an empty trailing pane.
          setInspectorSelection(null);
        }
      };
    }, [props.renderInspector]),
  );
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  // T3-CUSTOM(expbkt3): BEGIN — source-control identity: resolve the thread owner's profile.
  const sourceControlProfilesQuery = useEnvironmentQuery(
    environmentId === null ? null : sourceControlEnvironment.profiles({ environmentId, input: {} }),
  );
  // T3-CUSTOM(expbkt3): The header displays server-owned attribution state;
  // changing GitHub identity requires transferring durable thread ownership.
  const currentSourceControlProfile =
    (sourceControlProfilesQuery.data?.profiles ?? []).find(
      (profile) =>
        profile.ownerUserId !== null &&
        selectedThread?.ownerUserId != null &&
        String(profile.ownerUserId) === String(selectedThread.ownerUserId),
    ) ?? null;
  // T3-CUSTOM(expbkt3): END
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = useMemo(
    () =>
      selectedThread
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : null,
    [composer.interactionMode, composer.modelSelection, composer.runtimeMode, selectedThread],
  );

  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  const headerSubtitle = [
    selectedThreadProject?.title ?? null,
    selectedEnvironmentConnection?.environmentLabel ?? null,
    // T3-CUSTOM(expbkt3): source-control identity in the subtitle.
    currentSourceControlProfile ? `@${currentSourceControlProfile.login}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  /* ─── Git status for native header trigger ───────────────────────── */
  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          // T3-CUSTOM(expbkt3): source-control identity — resolve the thread's profile.
          input: { cwd: selectedThreadCwd, threadId: selectedThread.id },
        })
      : null,
  );
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.thread.worktreePath ?? null;
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);
  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = useCallback(() => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({ routeThreadIdentity, mode: "git" });
    showAuxiliaryPane("inspector");
  }, [fileInspector.supported, navigation, routeThreadIdentity, selectedThread, showAuxiliaryPane]);
  const handleOpenFilesInspector = useCallback(() => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({
      routeThreadIdentity,
      mode: props.renderInspector === undefined ? "files" : "route",
    });
    showAuxiliaryPane("inspector");
  }, [
    fileInspector.supported,
    navigation,
    props.renderInspector,
    routeThreadIdentity,
    selectedThread,
    selectedThreadCwd,
    showAuxiliaryPane,
  ]);
  const inspectorToggleActionRef = useRef({
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  });
  inspectorToggleActionRef.current = {
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  };
  const handleToggleInspector = useCallback(() => {
    const action = inspectorToggleActionRef.current;
    if (action.inspectorMode === null) {
      action.openFilesInspector();
      return;
    }
    action.toggleAuxiliaryPane();
  }, []);
  const handleSelectInspectorFile = useCallback(
    (path: string) => {
      if (selectedThread === null) {
        return;
      }
      const params = {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      if (fileInspector.supported) {
        navigation.navigate("ThreadFile", params);
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [fileInspector.supported, navigation, selectedThread],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // panes bring their own nested native headers (which underlap the status
  // bar); elsewhere the pane content pads itself below the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const GitInspector = useCallback(
    () => (
      <GitOverviewSheet
        headerInset={inspectorHeaderInset}
        presentation="inspector"
        route={{ params: props.route.params }}
      />
    ),
    [inspectorHeaderInset, props.route.params],
  );
  const FilesInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadCwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={selectedThreadCwd}
          environmentId={selectedThread.environmentId}
          headerInset={inspectorHeaderInset}
          projectName={selectedThreadProject?.title ?? "Files"}
          selectedPath={null}
          onSelectFile={handleSelectInspectorFile}
        />
      ) : null,
    [
      handleSelectInspectorFile,
      inspectorHeaderInset,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject?.title,
    ],
  );
  const RouteInspector = useCallback(
    () => props.renderInspector?.(inspectorHeaderInset),
    [inspectorHeaderInset, props.renderInspector],
  );
  const renderInspectorStack = useCallback(
    () =>
      inspectorMode === null ? null : (
        <ThreadInspectorContentStack
          Files={FilesInspector}
          Git={GitInspector}
          mode={inspectorMode}
          resetKeys={[routeThreadIdentity, selectedThreadCwd]}
          Route={props.renderInspector ? RouteInspector : undefined}
        />
      ),
    [
      FilesInspector,
      GitInspector,
      RouteInspector,
      inspectorMode,
      props.renderInspector,
      routeThreadIdentity,
      selectedThreadCwd,
    ],
  );
  const activeInspectorRenderer = inspectorMode === null ? undefined : renderInspectorStack;
  // Hand the inspector to the workspace so it renders beside the navigator,
  // outside this screen's native header — the terminal/git/files toolbar
  // stays anchored to the chat pane instead of floating above the inspector.
  useRegisterWorkspaceInspector(activeInspectorRenderer);

  const handleOpenConnectionEditor = useCallback(() => {
    void navigation.navigate("Connections");
  }, [navigation]);
  const handleStopThread = useCallback(() => {
    if (!selectedThread || composer.interruptibleRunId === null) {
      return;
    }
    return interruptThreadTurn({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        runId: composer.interruptibleRunId,
      },
    });
  }, [composer.interruptibleRunId, interruptThreadTurn, selectedThread]);

  const handleOpenTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
      });
    },
    [navigation, selectedThread, selectedThreadProject?.workspaceRoot],
  );

  const handleOpenNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  }, [navigation, selectedThread, selectedThreadProject?.workspaceRoot, terminalMenuSessions]);

  const handleRunProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-or-workspace",
        });
        return;
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
        hasRunningTerminal: terminalMenuSessions.some(
          (session) => session.status === "running" || session.status === "starting",
        ),
      });
      const preferredWorktreePath = resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetailWorktreePath,
      });
      const cwd = projectScriptCwd({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      stagePendingTerminalLaunch({
        target: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          terminalId: targetTerminalId,
        },
        launch: {
          cwd,
          worktreePath: preferredWorktreePath,
          env,
          initialInput: `${script.command}\r`,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: targetTerminalId,
      });
    },
    [
      navigation,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject,
      terminalMenuSessions,
    ],
  );
  const threadGitControlProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    auxiliaryPaneControl:
      !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null
        ? {
            accessibilityLabel: "Toggle inspector",
            onPress: handleToggleInspector,
          }
        : undefined,
    onOpenFilesInspector:
      fileInspector.supported && selectedThreadCwd !== null ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: fileInspector.supported ? handleOpenGitInspector : undefined,
    onMergeBack:
      mergeBackTargetThreadId !== null && mergeBackRun !== null
        ? () => void handleMergeBack()
        : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: gitStatus.data,
    gitOperationLabel: gitState.gitOperationLabel,
    canOpenTerminal: Boolean(selectedThreadProject?.workspaceRoot),
    canOpenFiles: Boolean(selectedThreadProject?.workspaceRoot),
    projectScripts: selectedThreadProject
      ? resolveProjectScripts(
          routeEnvironmentRuntime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
          selectedThreadProject,
        )
      : [],
    terminalSessions: terminalMenuSessions,
    showDirectFileControl: layout.usesSplitView,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  };
  // T3-CUSTOM(expbkt3): BEGIN — what this session costs at API prices, as a
  // header pill ahead of the git controls; tapping opens the breakdown sheet.
  const threadCost = useThreadUsage(
    environmentId,
    threadId === null ? null : ThreadId.make(threadId),
  );
  const threadCostHeader = useMemo(
    () =>
      threadCost.available && environmentId !== null && threadId !== null
        ? {
            label: threadCost.label,
            onPress: () =>
              navigation.navigate("ThreadUsage", {
                environmentId,
                threadId: ThreadId.make(threadId),
              }),
          }
        : null,
    [environmentId, navigation, threadCost.available, threadCost.label, threadId],
  );
  // T3-CUSTOM(expbkt3): END

  const handleEditFailedCreation = useCallback(async () => {
    const creation = selectedThreadCreation?.message;
    if (!creation?.creation || routeThreadIdentity === null) {
      return;
    }
    // The drain restored the prompt and attachments into the recovery draft
    // the rejected creation owns. Open that draft by id: without it the sheet
    // mints a fresh empty one and the restored content is unreachable.
    try {
      await recoverFailedThreadDraft(creation);
    } catch (error) {
      Alert.alert(
        "Could not restore draft",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    clearPendingThreadCreationOutcome(routeThreadIdentity);
    navigation.dispatch(
      StackActions.replace("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          draftId: restoredNewTaskDraftKey(creation.messageId),
          environmentId: String(creation.environmentId),
          projectId: String(creation.creation.projectId),
          ...(selectedThreadProject ? { title: selectedThreadProject.title } : {}),
        },
      }),
    );
  }, [navigation, routeThreadIdentity, selectedThreadCreation, selectedThreadProject]);
  const setupTurnStartedAt = composer.selectedThreadActivityRun?.startedAt ?? null;
  const { snapshot: worktreeSetupSnapshot, visible: worktreeSetup } = useWorktreeSetup({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    preparing:
      composer.selectedThreadActivityRun?.status === "preparing" ||
      selectedThread?.runtime?.status === "preparing" ||
      selectedThread?.worktreePath != null ||
      (selectedThreadCreation?.message.creation?.workspaceMode === "worktree" &&
        selectedThreadCreation.outcome == null),
    turnStarted: setupTurnStartedAt !== null,
    followUpSent:
      composer.selectedThreadFeed.filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ).length +
        composer.selectedThreadQueueCount >
      1,
  });
  const awaitingBootstrapTurn =
    worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : (selectedThreadDetail?.runs.some((run) => run.status === "preparing") ?? false);
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const handleCancelWorktreeSetup = useCallback(() => {
    if (!selectedThread) return;
    void cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
  }, [cancelWorktreeSetup, selectedThread]);
  const startLocalThread = useAtomCommand(threadEnvironment.startTurn, "work locally");
  const localResendBusy = useRef(false);
  const setupMessage = selectedThreadDetail?.messages.find((message) => message.role === "user");
  const handleWorkLocally = useCallback(async () => {
    if (!selectedThread || !selectedThreadProject || !setupMessage || localResendBusy.current)
      return;
    localResendBusy.current = true;
    try {
      const result = await cancelWorktreeSetup({
        environmentId: selectedThread.environmentId,
        input: { threadId: selectedThread.id },
      });
      if (result._tag !== "Success" || !result.value.cancelled) return;
      // V2 accepts the launch before setup runs, so cancellation never rejects
      // the original outbox delivery. Reuse the server-owned prompt and uploads.
      const metadata = makeTurnCommandMetadata();
      const launched = await startLocalThread({
        environmentId: selectedThread.environmentId,
        input: buildProjectThreadStartTurnInput({
          ...metadata,
          projectId: selectedThread.projectId,
          projectCwd: selectedThreadProject.workspaceRoot,
          text: setupMessage.text,
          ...(setupMessage.context ? { context: setupMessage.context } : {}),
          uploadedAttachments: setupMessage.attachments,
          modelSelection: selectedThread.modelSelection,
          runtimeMode: selectedThread.runtimeMode,
          interactionMode: selectedThread.interactionMode,
          workspaceMode: "local",
          branch: null,
          worktreePath: null,
          startFromOrigin: false,
          worktreeBranchName: "",
        }),
      });
      if (launched._tag !== "Success") return;
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(selectedThread.environmentId),
          threadId: metadata.threadId,
        }),
      );
    } finally {
      localResendBusy.current = false;
    }
  }, [
    cancelWorktreeSetup,
    navigation,
    selectedThread,
    selectedThreadProject,
    setupMessage,
    startLocalThread,
  ]);
  const creationState = ((): ThreadDetailScreenProps["creationState"] => {
    if (selectedThreadCreation === null) {
      return awaitingBootstrapTurn ? { kind: "preparing", preparingWorktree: true } : null;
    }
    if (selectedThreadCreation.outcome?.kind === "failed") {
      return {
        kind: "failed",
        reason: selectedThreadCreation.outcome.reason,
        onEditTask: handleEditFailedCreation,
      };
    }
    return {
      kind: "preparing",
      preparingWorktree: selectedThreadCreation.message.creation?.workspaceMode === "worktree",
    };
  })();
  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  // A queued creation renders as ready content: its prompt is the whole
  // conversation until the server creates the thread. The subscription's
  // not-found error for that window is expected, not a load failure.
  const contentPresentation =
    creationState !== null
      ? { kind: "ready" as const }
      : projectThreadContentPresentation({
          hasDetail: selectedThreadDetail !== null,
          detailError: Option.getOrNull(selectedThreadDetailState.error),
          detailDeleted: selectedThreadDetailState.status === "deleted",
          connectionState: routeConnectionState,
        });
  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const renderThreadRouteBody = () => (
    <>
      <GitActionProgressOverlay progress={gitActionProgress} onDismiss={dismissGitActionResult} />

      <View className="flex-1 bg-screen android:overflow-hidden android:rounded-t-[28px] android:bg-thread-canvas">
        <ThreadDetailScreen
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          feedbackSubmissions={composer.feedbackSubmissions}
          onDismissFeedback={composer.dismissFeedback}
          selectedThreadFeed={composer.selectedThreadFeed}
          activityRun={composer.selectedThreadActivityRun}
          activeWorkStartedAt={
            creationState?.kind === "preparing" ||
            (worktreeSetup !== null && setupTurnStartedAt === null)
              ? null
              : composer.activeWorkStartedAt
          }
          isCompacting={composer.isCompacting}
          runlessWorkActive={composer.runlessWorkActive}
          providerSubagentStatus={composer.providerSubagentStatus}
          creationState={creationState}
          setupWorkingStartedAt={
            composer.activeWorkStartedAt !== null &&
            worktreeSetupSnapshot !== null &&
            composer.selectedThreadFeed.filter(
              (entry) => entry.type === "message" && entry.message.role === "user",
            ).length <= 1
              ? composer.activeWorkStartedAt
              : null
          }
          worktreeSetup={
            worktreeSetup
              ? {
                  snapshot: worktreeSetup,
                  turnStartedAt: setupTurnStartedAt,
                  working: composer.activeWorkStartedAt !== null,
                  turnStarted: setupTurnStartedAt !== null,
                  onCancel: handleCancelWorktreeSetup,
                  onWorkLocally: setupMessage && selectedThreadProject ? handleWorkLocally : null,
                }
              : null
          }
          activePendingApproval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          draftMessage={composer.draftMessage}
          draftAttachments={composer.draftAttachments}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          historyControls={historyControls}
          activeThreadBusy={composer.activeThreadBusy}
          canStopThread={awaitingBootstrapTurn || composer.interruptibleRunId !== null}
          queuedRunEdit={composer.queuedRunEdit}
          composerDraftKey={composer.composerDraftKey}
          followUpBehavior={composer.followUpBehavior}
          canSteerActiveTurn={composer.canSteerActiveTurn}
          isSavingQueuedEdit={composer.isSavingQueuedEdit}
          onCancelQueuedRunEdit={composer.cancelQueuedRunEdit}
          onRemoveQueuedEditAttachment={composer.onRemoveQueuedEditAttachment}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          // T3-CUSTOM(expbkt3): durable outbox — a rejected queued message stays visible.
          failedOutboxDetail={composer.failedOutboxDetail}
          queuedMessages={composer.selectedThreadQueuedMessages}
          dispatchingMessageId={composer.dispatchingQueuedMessageId}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftMedia={composer.onPickDraftMedia}
          onPickDraftFiles={composer.onPickDraftFiles}
          onNativePasteImages={composer.onNativePasteImages}
          onNativePasteText={composer.onNativePasteText}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={awaitingBootstrapTurn ? handleCancelWorktreeSetup : handleStopThread}
          // T3-CUSTOM(expbkt3): deterministic outbox failures can be retried or edited.
          onRetryFailedOutbox={composer.onRetryFailedOutboxMessage}
          onEditFailedOutbox={composer.onEditFailedOutboxMessage}
          onSendMessage={composer.onSendMessage}
          onReconnectEnvironment={handleReconnectEnvironment}
          canSwitchThreadProvider={composer.canSwitchThreadProvider}
          onUpdateThreadModelSelection={composer.onUpdateModelSelection}
          onUpdateThreadRuntimeMode={composer.onUpdateRuntimeMode}
          onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
          onDismissUserInput={requests.onDismissUserInput}
        />
      </View>
    </>
  );

  return (
    <>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}
      <ThreadHeader
        title={selectedThread.title}
        subtitle={headerSubtitle}
        headerColor={headerColor}
        usesNativeHeaderGlass={usesNativeHeaderGlass}
        gitControls={threadGitControlProps}
        hasThreadCwd={selectedThreadCwd !== null}
        hasWorkspaceRoot={Boolean(selectedThreadProject?.workspaceRoot)}
        fileInspectorSupported={fileInspector.supported}
        inspectorMode={inspectorMode}
        onToggleInspector={handleToggleInspector}
        onOpenGitInspector={handleOpenGitInspector}
        onOpenFilesInspector={handleOpenFilesInspector}
        onReturnToThread={props.onReturnToThread}
        // T3-CUSTOM(expbkt3): per-thread API-level cost pill.
        threadCostHeader={threadCostHeader}
      />

      {renderThreadRouteBody()}
    </>
  );
}
