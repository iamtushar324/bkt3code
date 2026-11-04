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

/** Drain queued mutations too; optimistic publication precedes the durable file write. */
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

export function confirmThreadOutboxMessageQueued(message: QueuedThreadMessage): Promise<boolean> {
  return threadOutboxManager.confirmQueued(message);
}

/** Returns false if removed or if expectedRevision differs from threadOutboxRevision; otherwise rewrites the message. */
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

// Removal needs draft-state ownership to release files; keep that dependency outside this module.
