/**
 * T3-CUSTOM(expbkt3): the three ways a user sends review comments on purpose.
 *
 * Each sends its own message through the thread's run queue, so the draft in
 * the chat box stays as it is, and a running turn is never interrupted: the
 * message waits behind it. The server appends the comments not sent yet when
 * the turn starts. "Address remaining" and "Ask for an update" first mark every
 * open comment not sent, so they go again with that turn.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { toastManager } from "../../components/ui/toast";
import { sendThreadPrompt } from "../smartGit/sendThreadPrompt";
import { useThreadCommentsCommands } from "./hooks";
import {
  THREAD_COMMENTS_ADDRESS_REMAINING_TEXT,
  THREAD_COMMENTS_ASK_UPDATE_TEXT,
  THREAD_COMMENTS_EMPTY_SEND_TEXT,
} from "./model";

function reportSend(threadRef: ScopedThreadRef, result: ReturnType<typeof sendThreadPrompt>) {
  if (result === "unavailable") {
    toastManager.add({
      type: "error",
      title: "Could not send the comments",
      description: "The thread is not available. Try again in a moment.",
      data: { threadRef },
    });
    return;
  }
  toastManager.add({
    type: "info",
    title: result === "duplicate" ? "Already queued" : "Comments sent",
    description:
      result === "send"
        ? "The agent works through them now."
        : "They go when the current turn ends.",
    data: { threadRef },
  });
}

export function useCommentSendActions(threadRef: ScopedThreadRef | null) {
  const commands = useThreadCommentsCommands();

  const sendNow = useCallback(() => {
    if (threadRef === null) return;
    reportSend(threadRef, sendThreadPrompt(threadRef, THREAD_COMMENTS_EMPTY_SEND_TEXT));
  }, [threadRef]);

  const resendWith = useCallback(
    async (text: string) => {
      if (threadRef === null) return;
      // The re-send mark must land before the turn reads the open comments;
      // a failed mark is reported by the command, and nothing is sent.
      const marked = await commands.resend({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (marked._tag !== "Success") return;
      reportSend(threadRef, sendThreadPrompt(threadRef, text));
    },
    [commands, threadRef],
  );

  return useMemo(
    () => ({
      sendNow,
      addressRemaining: () => void resendWith(THREAD_COMMENTS_ADDRESS_REMAINING_TEXT),
      askForUpdate: () => void resendWith(THREAD_COMMENTS_ASK_UPDATE_TEXT),
    }),
    [resendWith, sendNow],
  );
}
