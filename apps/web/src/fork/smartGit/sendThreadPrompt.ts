// T3-CUSTOM(expbkt3): smart git prompts use the native durable run queue.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { CommandId, MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import type { SmartGitDelivery } from "@t3tools/client-runtime/state/smart-git-intent";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { readEnvironmentOperatorUserId } from "../environmentOperatorIdentity";
import { environmentThreadDetails, threadEnvironment } from "~/state/threads";
import { randomUUID } from "~/lib/utils";
import { currentClerkUserAtom } from "~/state/identity";

export type SendThreadPromptResult = SmartGitDelivery | "duplicate" | "unavailable";
const pendingPrompts = new Set<string>();

/** Sends independently of the draft, preserving order behind an active run. */
export function sendThreadPrompt(threadRef: ScopedThreadRef, text: string): SendThreadPromptResult {
  const shell = readThreadShell(threadRef);
  if (shell === null) return "unavailable";
  const key = JSON.stringify([scopedThreadKey(threadRef), text]);
  const projection = appAtomRegistry.get(
    environmentThreadDetails.threadAtom(threadRef),
  )?.projection;
  const queuedRunIds = new Set(
    projection?.runs.filter((run) => run.status === "queued").map((run) => run.id) ?? [],
  );
  const queuedMessages =
    projection?.messages.filter(
      (message) => message.runId !== null && queuedRunIds.has(message.runId),
    ) ?? [];
  if (pendingPrompts.has(key) || queuedMessages.some((message) => message.text === text))
    return "duplicate";
  const delivery =
    shell.runtime?.status === "running" ||
    shell.runtime?.status === "starting" ||
    shell.runtime?.status === "preparing" ||
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    queuedMessages.length > 0
      ? "queue"
      : "send";
  pendingPrompts.add(key);
  void runAtomCommand(appAtomRegistry, threadEnvironment.startTurn, {
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      commandId: CommandId.make(randomUUID()),
      message: { messageId: MessageId.make(randomUUID()), role: "user", text, attachments: [] },
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: "default",
      dispatchMode: delivery === "queue" ? "queue" : "auto",
      outboxIdentityKey:
        appAtomRegistry.get(currentClerkUserAtom) ?? readEnvironmentOperatorUserId() ?? "anonymous",
    },
  }).finally(() => pendingPrompts.delete(key));
  return delivery;
}
