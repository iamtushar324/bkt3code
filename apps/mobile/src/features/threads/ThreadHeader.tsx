import { StackActions, useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
// T3-CUSTOM(expbkt3): Platform — iOS gets the fork's right-side header items.
import { Platform } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { ScreenHeaderButton } from "../../components/ScreenHeaderButton";
import type { ScreenHeaderAction } from "../../components/ScreenHeader.types";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-content-stack";
import { useThreadHeaderOptions } from "./useThreadHeaderOptions";
// T3-CUSTOM(expbkt3): compact headers keep Git utilities; the cost pill leads them.
import { useThreadGitCenterHeaderItems, useThreadGitCompactHeaderItems } from "./ThreadGitControls";
// T3-CUSTOM(expbkt3): smart git action asks the agent (features/smartgit).
import { useSmartGitAction } from "../smartgit/useSmartGitAction";

export function ThreadHeader(
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
  const forkRightHeaderItems = layout.usesSplitView
    ? forkCenterHeaderItems
    : forkCompactHeaderItems;
  const nativeOptions =
    Platform.OS === "android"
      ? native.options
      : {
          ...native.options,
          unstable_headerRightItems: () => [...threadCostHeaderItems, ...forkRightHeaderItems],
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
    if (props.hasWorkspaceRoot && props.gitControls.canOpenTerminal) {
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
    props.gitControls.canOpenTerminal,
  ]);

  return (
    <>
      <ScreenHeader
        title={props.title}
        subtitle={props.subtitle}
        sidebar={native.sidebar}
        // T3-CUSTOM(expbkt3): fork right-side header items (cost pill, compact Git menu).
        options={nativeOptions}
        // T3-CUSTOM(expbkt3): re-apply header items when the fork's right items,
        // the cost label, project scripts or the smart git action change.
        optionsVersion={[
          ...native.optionsVersion,
          forkRightHeaderItems,
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
