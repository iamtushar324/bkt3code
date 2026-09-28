// T3-CUSTOM(expbkt3): fork-owned — the chat header's smart git action.
import {
  isSmartGitPromptIntent,
  resolveSmartGitIntent,
  smartGitPromptForStatus,
  smartGitToastTitle,
  type SmartGitIntent,
} from "@t3tools/client-runtime/state/smart-git-intent";
import type { ScopedThreadRef, SourceControlProfileId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { useSourceControlActionRunning } from "~/lib/sourceControlActions";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";

import { sendThreadPrompt } from "./sendThreadPrompt";

// Same set GitActionsControl treats as "a git action is running".
const RUNNING_SOURCE_CONTROL_ACTIONS = ["runStackedAction", "pull", "publishRepository"] as const;

export interface SmartGitAction {
  /** The smart button replaces upstream's quick action. False keeps upstream's button. */
  readonly visible: boolean;
  readonly intent: SmartGitIntent;
  readonly SourceControlIcon: ReturnType<typeof getSourceControlPresentation>["Icon"];
  readonly run: () => void;
}

const selectSmartGitPromptsEnabled = (settings: { smartGitPromptsEnabled: boolean }) =>
  settings.smartGitPromptsEnabled;

/**
 * Reads the worktree's status through the same query GitActionsControl uses
 * (one shared subscription, refreshed on focus by GitActionsControl), and
 * turns a click into a prompt for the agent. Visible only for server threads
 * with a worktree whose state calls for commit, push or a new change request;
 * every other state keeps upstream's quick action.
 */
export function useSmartGitAction(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly gitCwd: string | null;
  readonly sourceControlProfileId: SourceControlProfileId | null;
}): SmartGitAction {
  const { threadRef, gitCwd, sourceControlProfileId } = input;
  const enabled = useClientSettings(selectSmartGitPromptsEnabled);
  const shell = useThreadShell(threadRef);
  const active = enabled && threadRef !== null && shell !== null && gitCwd !== null;
  const { data: gitStatus } = useEnvironmentQuery(
    active
      ? vcsEnvironment.status({
          environmentId: threadRef.environmentId,
          // Same key order as GitActionsControl so both read one subscription.
          input: { cwd: gitCwd, threadId: threadRef.threadId },
        })
      : null,
  );
  const scope = useMemo(
    () => ({
      environmentId: threadRef?.environmentId ?? null,
      cwd: gitCwd,
      threadId: threadRef?.threadId ?? null,
      sourceControlProfileId,
    }),
    [gitCwd, sourceControlProfileId, threadRef?.environmentId, threadRef?.threadId],
  );
  const isBusy = useSourceControlActionRunning(scope, RUNNING_SOURCE_CONTROL_ACTIONS);
  const intent = useMemo(
    () =>
      resolveSmartGitIntent(gitStatus, {
        isBusy,
        isDefaultRef: gitStatus?.isDefaultRef ?? false,
        hasPrimaryRemote: gitStatus?.hasPrimaryRemote ?? false,
      }),
    [gitStatus, isBusy],
  );
  const presentation = getSourceControlPresentation(gitStatus?.sourceControlProvider);
  const run = useCallback(() => {
    if (threadRef === null || !isSmartGitPromptIntent(intent.intent)) return;
    const prompt = smartGitPromptForStatus(intent, gitStatus);
    if (prompt === null) return;
    const result = sendThreadPrompt(threadRef, prompt);
    if (result === "unavailable") return;
    if (result === "duplicate") {
      toastManager.add({
        type: "info",
        title: "Already queued",
        description: "This request is waiting in the thread's queue.",
        data: { threadRef },
      });
      return;
    }
    toastManager.add({
      type: result === "queue" ? "info" : "success",
      title: smartGitToastTitle(intent.intent, result, presentation.terminology.shortLabel),
      description:
        result === "queue"
          ? "It waits in the queue above the composer and goes out at the agent's next stopping point."
          : prompt,
      data: { threadRef },
    });
  }, [gitStatus, intent, presentation.terminology.shortLabel, threadRef]);

  return {
    visible: active && isSmartGitPromptIntent(intent.intent),
    intent,
    SourceControlIcon: presentation.Icon,
    run,
  };
}
