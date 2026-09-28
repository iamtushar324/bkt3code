// T3-CUSTOM(expbkt3): fork-owned — the thread header's smart git action on mobile.
//
// Mirrors web's fork/smartGit: while the worktree needs a commit, a push or a
// new change request, the header's primary git action asks the agent to do it
// instead of running git. The prompt goes through the durable thread outbox,
// the same path as a composer send, so it starts a turn when the thread is idle
// and waits its turn otherwise. Mobile has no client-settings store, so the
// web "Smart git button" toggle does not apply here; it is always on.
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isSmartGitPromptIntent,
  resolveSmartGitIntent,
  smartGitPromptForStatus,
  type SmartGitIntent,
} from "@t3tools/client-runtime/state/smart-git-intent";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useEnvironmentServerConfig, useThreadShell } from "../../state/entities";
import { resolveProviderInteractionMode } from "../../state/legacy-plan-mode";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { setPendingConnectionError } from "../../state/use-remote-environment-registry";
import { useThreadOutboxMessages } from "../../state/use-thread-outbox";

export type SmartGitActionIcon = "checkmark.circle" | "arrow.up.circle" | "arrow.up.right.circle";

export interface MobileSmartGitAction {
  /** The smart action stands in for upstream's quick action. False keeps upstream's. */
  readonly visible: boolean;
  readonly intent: SmartGitIntent;
  readonly icon: SmartGitActionIcon;
  /** Pending work: the header's git item switches to the prominent (tinted) style. */
  readonly highlighted: boolean;
  /** Changes whenever what the header shows changes, for native header re-application. */
  readonly headerVersion: string;
  readonly run: () => void;
}

function iconFor(intent: SmartGitIntent): SmartGitActionIcon {
  if (intent.intent === "commit") return "checkmark.circle";
  if (intent.intent === "push") return "arrow.up.circle";
  return "arrow.up.right.circle";
}

export function useSmartGitAction(input: {
  readonly environmentId: EnvironmentId | string;
  readonly threadId: ThreadId | string;
  readonly gitStatus: VcsStatusResult | null;
  readonly gitOperationLabel: string | null;
}): MobileSmartGitAction {
  const { gitStatus } = input;
  const environmentIdValue = String(input.environmentId);
  const threadIdValue = String(input.threadId);
  const threadRef = useMemo(
    () =>
      environmentIdValue && threadIdValue
        ? scopeThreadRef(EnvironmentId.make(environmentIdValue), ThreadId.make(threadIdValue))
        : null,
    [environmentIdValue, threadIdValue],
  );
  const shell = useThreadShell(threadRef);
  const serverConfig = useEnvironmentServerConfig(threadRef?.environmentId ?? null);
  const outboxMessages = useThreadOutboxMessages();

  const intent = useMemo(
    () =>
      resolveSmartGitIntent(gitStatus, {
        isBusy: input.gitOperationLabel !== null,
        isDefaultRef: gitStatus?.isDefaultRef ?? false,
        hasPrimaryRemote: gitStatus?.hasPrimaryRemote ?? false,
      }),
    [gitStatus, input.gitOperationLabel],
  );
  const visible = shell !== null && isSmartGitPromptIntent(intent.intent);

  const run = useCallback(() => {
    if (!shell) return;
    const prompt = smartGitPromptForStatus(intent, gitStatus);
    if (prompt === null) return;
    const queued = outboxMessages[scopedThreadKey(shell.environmentId, shell.id)] ?? [];
    if (queued.some((message) => message.text === prompt && message.deliveryState !== "failed")) {
      Alert.alert("Already queued", "This request is waiting in the thread's queue.");
      return;
    }
    const metadata = makeQueuedMessageMetadata();
    const provider = serverConfig?.providers.find(
      (entry) => entry.instanceId === shell.modelSelection.instanceId,
    );
    enqueueThreadOutboxMessage({
      environmentId: shell.environmentId,
      threadId: shell.id,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: prompt,
      attachments: [],
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      // Committing and opening a PR are actions: build mode even from plan mode.
      interactionMode: resolveProviderInteractionMode(provider, "default"),
      createdAt: metadata.createdAt,
    }).catch((error: unknown) => {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
  }, [gitStatus, intent, outboxMessages, serverConfig, shell]);

  return {
    visible,
    intent,
    icon: iconFor(intent),
    highlighted: visible && intent.highlighted,
    headerVersion: visible ? `${intent.intent}:${intent.label}:${intent.hint ?? ""}` : "off",
    run,
  };
}
