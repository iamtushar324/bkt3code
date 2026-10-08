/**
 * T3-CUSTOM(expbkt3): data hooks for review comments on agent messages.
 *
 * One live snapshot per thread: the one-shot list seeds it, the subscription
 * supersedes it as soon as a frame arrives, and both are atom families so the
 * panel, the highlights and the composer strip share a single stream.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadCommentsSnapshot } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadCommentsEnvironment } from "../../state/threadComments";
import { useAtomCommand } from "../../state/use-atom-command";
import { allowsEmptySend, countCommentDelivery, countComments } from "./model";
import { useThreadCommentsUiStore } from "./uiStore";

/** The setting is on and the thread's server speaks the fork RPCs. */
export function useThreadCommentsEnabled(environmentId: EnvironmentId | null | undefined): boolean {
  const settingOn = useClientSettings((settings) => settings.chatCommentsEnabled);
  const serverConfigs = useServerConfigs();
  if (!settingOn || !environmentId) return false;
  return serverConfigs.get(environmentId)?.environment.capabilities.threadComments === true;
}

export function useThreadCommentsSnapshot(
  threadRef: ScopedThreadRef | null,
  enabled: boolean,
): ThreadCommentsSnapshot | null {
  // A local draft has no server thread yet: its subscription would fail
  // "not-found" and never retry. The shell appears once the draft is promoted,
  // which is when the atoms first mount.
  const shell = useThreadShell(threadRef);
  const target =
    enabled && threadRef !== null && shell !== null
      ? { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } }
      : null;
  const initial = useEnvironmentQuery(
    target === null ? null : threadCommentsEnvironment.list(target),
  );
  const live = useEnvironmentQuery(
    target === null ? null : threadCommentsEnvironment.subscription(target),
  );
  return live.data ?? initial.data ?? null;
}

export function useThreadCommentsCommands() {
  const add = useAtomCommand(threadCommentsEnvironment.add);
  const reply = useAtomCommand(threadCommentsEnvironment.reply);
  const setStatus = useAtomCommand(threadCommentsEnvironment.setStatus);
  const resolveAll = useAtomCommand(threadCommentsEnvironment.resolveAll);
  const remove = useAtomCommand(threadCommentsEnvironment.remove);
  const setDeliveryPaused = useAtomCommand(threadCommentsEnvironment.setDeliveryPaused);
  const resend = useAtomCommand(threadCommentsEnvironment.resend);
  return useMemo(
    () => ({ add, reply, setStatus, resolveAll, remove, setDeliveryPaused, resend }),
    [add, reply, setStatus, resolveAll, remove, setDeliveryPaused, resend],
  );
}

/**
 * Publishes the active thread's summary for the readers that have no thread
 * ref (the tab badge, the composer's send gate). Mounted once by `ChatView`.
 */
export function useThreadCommentsActiveSummary(
  threadRef: ScopedThreadRef | null,
  enabled: boolean,
  snapshot: ThreadCommentsSnapshot | null,
  running: boolean,
): void {
  const setActive = useThreadCommentsUiStore((state) => state.setActive);
  const openCount = snapshot === null ? 0 : countComments(snapshot.comments).open;
  const delivery = countCommentDelivery(snapshot?.comments ?? []);
  const deliveryPaused = snapshot?.deliveryPaused ?? false;
  const threadKey = threadRef === null ? null : scopedThreadKey(threadRef);
  const { unsent: unsentCount, sent: sentCount, addressed: addressedCount } = delivery;
  useEffect(() => {
    if (threadKey === null || threadRef === null) {
      setActive(null);
      return;
    }
    setActive({
      threadKey,
      threadRef,
      openCount,
      unsentCount,
      sentCount,
      addressedCount,
      deliveryPaused,
      enabled,
      running,
    });
    // threadRef is keyed by threadKey; a new object for the same thread changes nothing.
  }, [
    addressedCount,
    deliveryPaused,
    enabled,
    openCount,
    running,
    sentCount,
    setActive,
    threadKey,
    unsentCount,
  ]);
  useEffect(() => () => setActive(null), [setActive]);
}

/** Whether the composer may send an empty message on the active thread. */
export function useThreadCommentsEmptySendAllowed(): boolean {
  return useThreadCommentsUiStore((state) =>
    state.active === null
      ? false
      : allowsEmptySend({
          enabled: state.active.enabled,
          unsentCount: state.active.unsentCount,
          deliveryPaused: state.active.deliveryPaused,
          running: state.active.running,
        }),
  );
}

/** Same answer for code outside React (the send body reads it at click time). */
export function threadCommentsEmptySendAllowed(): boolean {
  const active = useThreadCommentsUiStore.getState().active;
  return active !== null && allowsEmptySend(active);
}
