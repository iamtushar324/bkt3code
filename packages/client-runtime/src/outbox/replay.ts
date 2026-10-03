// T3-CUSTOM(expbkt3): route-independent delivery of auth-scoped persisted turns.
// @effect-diagnostics globalTimers:off - This React lifecycle runner owns and disposes its callback timers outside an Effect runtime.
import type { CommandId, EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "../state/runtime.ts";
import {
  beginThreadOutboxDelivery,
  selectThreadOutboxReplay,
  settleThreadOutboxDelivery,
  threadOutboxDeliveryKey,
} from "./delivery.ts";
import {
  ANONYMOUS_OUTBOX_IDENTITY,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
  type ThreadSettingsSnapshot,
} from "./model.ts";

/** A first turn can create its thread before any shell row exists. */
export function queuedThreadReplaySettings(
  message: QueuedThreadMessage,
  thread: ThreadSettingsSnapshot | null,
): ThreadSettingsSnapshot | null {
  const bootstrap = message.bootstrap?.createThread;
  if (thread === null && bootstrap === undefined) return null;
  const modelSelection =
    message.modelSelection ?? thread?.modelSelection ?? bootstrap?.modelSelection;
  const runtimeMode = message.runtimeMode ?? thread?.runtimeMode ?? bootstrap?.runtimeMode;
  const interactionMode =
    message.interactionMode ?? thread?.interactionMode ?? bootstrap?.interactionMode;
  return modelSelection && runtimeMode && interactionMode
    ? { modelSelection, runtimeMode, interactionMode }
    : null;
}

export interface DurableOutboxReplayState {
  readonly items: ReadonlyArray<QueuedThreadMessage>;
  readonly connected: boolean;
  readonly shellLive: boolean;
  readonly threadSettings: (message: QueuedThreadMessage) => ThreadSettingsSnapshot | null;
  readonly isCommitted: (message: QueuedThreadMessage) => boolean;
}

/** One serial lane per environment; the server controls busy-thread queues. */
export function createDurableOutboxReplay(options: {
  readonly environmentId: EnvironmentId;
  readonly identityKey: string;
  readonly dispatch: (
    message: QueuedThreadMessage,
    settings: ThreadSettingsSnapshot,
    stillCurrent: () => boolean,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
  readonly discard: (message: QueuedThreadMessage) => Promise<unknown>;
  readonly fail: (message: QueuedThreadMessage) => Promise<unknown>;
}) {
  let state: DurableOutboxReplayState | null = null;
  let disposed = false;
  let running = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryCommandId: CommandId | null = null;
  const attempts = new Map<CommandId, number>();
  const terminalCommands = new Set<CommandId>();
  const discarding = new Set<string>();
  const inFlight = new Set<string>();
  const owns = (message: QueuedThreadMessage) =>
    message.environmentId === options.environmentId &&
    (message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY) === options.identityKey;
  const isPending = (message: QueuedThreadMessage) =>
    !disposed &&
    state?.items.some(
      (queued) =>
        owns(queued) &&
        queued.commandId === message.commandId &&
        queued.messageId === message.messageId &&
        queued.deliveryState !== "failed" &&
        !state!.isCommitted(queued),
    ) === true;
  const remove = (message: QueuedThreadMessage) => {
    if (discarding.has(message.messageId)) return;
    discarding.add(message.messageId);
    void options.discard(message).finally(() => discarding.delete(message.messageId));
  };
  const scheduleRetry = (message: QueuedThreadMessage) => {
    if (
      disposed ||
      !state?.connected ||
      !state.items.some(
        (item) =>
          owns(item) && item.commandId === message.commandId && item.deliveryState !== "failed",
      )
    )
      return;
    const attempt = (attempts.get(message.commandId) ?? 0) + 1;
    attempts.set(message.commandId, attempt);
    retryCommandId = message.commandId;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      retryCommandId = null;
      void pump();
    }, threadOutboxRetryDelayMs(attempt));
  };
  let wakeRequested = false;
  const pump = async (): Promise<void> => {
    if (disposed || running || retryTimer !== null || !state?.connected || !state.shellLive) return;
    running = true;
    wakeRequested = false;
    let replayed = false;
    let delivered = false;
    let deliveryKey: string | null = null;
    let next: QueuedThreadMessage | undefined;
    try {
      const eligible = state.items.filter(owns).filter((message) => {
        if (state!.isCommitted(message)) {
          remove(message);
          return false;
        }
        return (
          !terminalCommands.has(message.commandId) &&
          queuedThreadReplaySettings(message, state!.threadSettings(message)) !== null
        );
      });
      const selected = selectThreadOutboxReplay({
        items: eligible,
        identityKey: options.identityKey,
        replayingMessageIds: inFlight,
      });
      for (const message of selected.stale) remove(message);
      next = selected.next;
      if (next === undefined) return;
      const settings = queuedThreadReplaySettings(next, state.threadSettings(next));
      if (settings === null) return;
      const message = next;
      deliveryKey = threadOutboxDeliveryKey({ ...message, identityKey: options.identityKey });
      inFlight.add(message.messageId);
      beginThreadOutboxDelivery(deliveryKey);
      replayed = true;
      const stillCurrent = () =>
        !disposed &&
        state?.connected === true &&
        state.items.some(
          (queued) =>
            owns(queued) &&
            queued.commandId === message.commandId &&
            queued.deliveryState !== "failed" &&
            !state!.isCommitted(queued),
        );
      const result = await options.dispatch(message, settings, stillCurrent);
      if (result === null) return;
      if (result._tag === "Success") {
        delivered = true;
        attempts.delete(message.commandId);
      } else {
        const error = squashAtomCommandFailure(result);
        if (
          !disposed &&
          (isAtomCommandInterrupted(result) || shouldRetryThreadOutboxDelivery(error))
        ) {
          scheduleRetry(message);
        } else if (isPending(message)) {
          terminalCommands.add(message.commandId);
          await options.fail({
            ...message,
            deliveryState: "failed",
            failureDetail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (next && !disposed && shouldRetryThreadOutboxDelivery(error)) {
        scheduleRetry(next);
      } else if (next && isPending(next)) {
        terminalCommands.add(next.commandId);
        await options.fail({
          ...next,
          deliveryState: "failed",
          failureDetail:
            error instanceof Error ? error.message : "Could not prepare the saved message.",
        });
      }
    } finally {
      if (deliveryKey !== null) settleThreadOutboxDelivery(deliveryKey, delivered);
      if (next !== undefined) inFlight.delete(next.messageId);
      running = false;
      if (!disposed && retryTimer === null && (replayed || wakeRequested)) void pump();
    }
  };
  return {
    update: (next: DurableOutboxReplayState) => {
      state = next;
      wakeRequested = true;
      const pendingCommands = new Set(
        next.items
          .filter(owns)
          .filter((message) => message.deliveryState !== "failed")
          .map((message) => message.commandId),
      );
      for (const commandId of terminalCommands)
        if (!pendingCommands.has(commandId)) terminalCommands.delete(commandId);
      for (const commandId of attempts.keys())
        if (!pendingCommands.has(commandId)) attempts.delete(commandId);
      if (
        retryTimer !== null &&
        (!next.connected || retryCommandId === null || !pendingCommands.has(retryCommandId))
      ) {
        clearTimeout(retryTimer);
        retryTimer = null;
        retryCommandId = null;
      }
      void pump();
    },
    dispose: () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      retryCommandId = null;
    },
  };
}
