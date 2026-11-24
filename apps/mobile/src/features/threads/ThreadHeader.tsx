import { useGT, useMessages } from "gt-react-native";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
// T3-CUSTOM(expbkt3): smart git action asks the agent (features/smartgit).
import { useSmartGitAction } from "../smartgit/useSmartGitAction";

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  // T3-CUSTOM(expbkt3): per-thread API-level cost pill.
  readonly threadCostHeader?: { readonly label: string; readonly onPress: () => void } | null;
}) {
  const gt = useGT();
  const m = useMessages();
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  // T3-CUSTOM(expbkt3): smart git leads as a direct button, selected while work is pending.
  const smartGit = useSmartGitAction(props.gitControls);
  const forkActions: AppBarAction[] = [
    ...(smartGit.visible
      ? [
          {
            accessibilityLabel: gt("{action}: ask the agent", { action: smartGit.intent.label }),
            icon: smartGit.icon,
            selected: smartGit.intent.highlighted,
            onPress: smartGit.run,
          },
        ]
      : []),
    ...(props.threadCostHeader
      ? [
          {
            accessibilityLabel: gt("Session cost {cost}", { cost: props.threadCostHeader.label }),
            icon: "dollarsign.circle" as const,
            onPress: props.threadCostHeader.onPress,
          },
        ]
      : []),
  ];
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      // T3-CUSTOM(expbkt3): the smart git action and cost pill lead the bar actions.
      actions={[...forkActions, ...actions]}
      menus={menus}
      // T3-CUSTOM(expbkt3): re-apply bar items when the cost label or smart git action change.
      optionsVersion={[props.threadCostHeader?.label, smartGit.headerVersion]}
      hideBottomBorder
    />
  );
}
