// T3-CUSTOM(expbkt3): BEGIN — identity-scoped shared outbox model.
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import { ANONYMOUS_OUTBOX_IDENTITY } from "@t3tools/client-runtime/outbox";

import { appAtomRegistry } from "./atom-registry";
import { createThreadOutboxManager } from "./thread-outbox-manager";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { expoThreadOutboxStorage, flushThreadOutboxWrites } from "./thread-outbox-storage";

export * from "./thread-outbox-model";

function asPendingMessage(message: QueuedThreadMessage, identityKey: string): QueuedThreadMessage {
  const { deliveryState: _deliveryState, failureDetail: _failureDetail, ...pending } = message;
  return { ...pending, identityKey, deliveryState: "pending" };
}
// T3-CUSTOM(expbkt3): END

export const threadOutboxManager = createThreadOutboxManager({
  registry: appAtomRegistry,
  storage: expoThreadOutboxStorage,
});

/**
 * Lands queued outbox mutations before the JS runtime is torn down (app update
 * restart). An enqueued message is published to the atom immediately but its
 * durable write waits behind the mutation queue, so draining only the writes
 * already mid-file would miss it.
 */
export async function flushThreadOutbox(): Promise<void> {
  await threadOutboxManager.serialize(async () => {});
  await flushThreadOutboxWrites();
}

// T3-CUSTOM(expbkt3): retain the fork eager-load entry point.
export function ensureThreadOutboxLoaded(): void {
  void threadOutboxManager.load();
}

// T3-CUSTOM(expbkt3): BEGIN — preserve identity and explicit delivery state.
export function enqueueThreadOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  const identityKey =
    message.identityKey ??
    appAtomRegistry.get(managedRelaySessionAtom)?.accountId ??
    ANONYMOUS_OUTBOX_IDENTITY;
  return threadOutboxManager.enqueue(asPendingMessage(message, identityKey));
}

/** Waits for pending writes to settle; false if the message was rolled back. */
export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/**
 * Rewrite a queued message; no-op (false) if it was removed in the meantime,
 * or (with `expectedRevision` from `threadOutboxRevision`) if any other write
 * was accepted since the revision was read.
 */
export function updateThreadOutboxMessage(
  message: QueuedThreadMessage,
  expectedRevision?: number,
): Promise<boolean> {
  // T3-CUSTOM(expbkt3): identity survives upload CAS and editor retry.
  const identityKey =
    message.identityKey ??
    appAtomRegistry.get(managedRelaySessionAtom)?.accountId ??
    ANONYMOUS_OUTBOX_IDENTITY;
  // Upload CAS requires the exact published object for its post-write ownership check.
  return threadOutboxManager.update(
    expectedRevision === undefined ? asPendingMessage(message, identityKey) : message,
    expectedRevision,
  );
}

/** Snapshot of a queued message's write revision, for update's CAS. */
export function threadOutboxRevision(messageId: QueuedThreadMessage["messageId"]): number {
  return threadOutboxManager.revisionOf(messageId);
}

export function markThreadOutboxMessageFailed(
  message: QueuedThreadMessage,
  failureDetail: string,
  expectedRevision?: number,
): Promise<boolean> {
  return threadOutboxManager.update(
    {
      ...message,
      deliveryState: "failed",
      failureDetail,
    },
    expectedRevision,
  );
}
// T3-CUSTOM(expbkt3): END

// Removal lives in `thread-outbox-removal.ts`: taking a message out of the
// outbox must also release its local attachment files, and that owner needs
// the composer draft state this module must not depend on.
