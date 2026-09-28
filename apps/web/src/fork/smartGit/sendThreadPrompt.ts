// T3-CUSTOM(expbkt3): fork-owned — sends a smart git prompt into a thread.
//
// The prompt goes through upstream's queued-message store, so it follows the
// same rules as a composer send: `QueuedMessageSender` (mounted at the root)
// starts the turn right away when the thread is idle, and holds it behind a
// running turn, a pending approval or an unfinished queue otherwise. It never
// reads or clears the composer draft.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  resolveSmartGitDelivery,
  type SmartGitDelivery,
} from "@t3tools/client-runtime/state/smart-git-intent";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { latestCompletedToolActivityId, useQueuedMessageStore } from "~/queuedMessageStore";
import { readThread, readThreadShell } from "~/state/entities";

export type SendThreadPromptResult = SmartGitDelivery | "duplicate" | "unavailable";

/**
 * Queues `text` as a user message on the thread, using the thread's current
 * model, runtime mode and interaction mode. "duplicate" means the same prompt
 * is already waiting in the queue; "unavailable" means the thread has no
 * server record yet (a draft).
 */
export function sendThreadPrompt(threadRef: ScopedThreadRef, text: string): SendThreadPromptResult {
  const shell = readThreadShell(threadRef);
  if (!shell) return "unavailable";
  const threadKey = scopedThreadKey(threadRef);
  const store = useQueuedMessageStore.getState();
  const queue = store.queuesByThreadKey[threadKey] ?? [];
  if (queue.some((message) => message.sending === undefined && message.prompt === text)) {
    return "duplicate";
  }
  const delivery = resolveSmartGitDelivery({
    // A starting session and an open approval or question hold the queue too.
    turnRunning:
      shell.session?.status === "running" ||
      shell.session?.status === "starting" ||
      shell.hasPendingApprovals ||
      shell.hasPendingUserInput,
    queueStillSending: queue.some(
      (message) => message.sending !== undefined || !message.holdUntilUserAction,
    ),
  });
  store.enqueue(threadKey, {
    prompt: text,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      // Committing and opening a PR are actions: send in build mode even from a
      // thread parked in plan mode, like approving a plan does.
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: latestCompletedToolActivityId(
      readThread(threadRef)?.activities ?? [],
    ),
    createdAt: new Date().toISOString(),
  });
  return delivery;
}
