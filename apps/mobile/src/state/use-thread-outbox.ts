import { useAtomValue } from "@effect/atom-react";
// T3-CUSTOM(expbkt3): BEGIN — render only the authenticated identity's queue.
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import {
  ANONYMOUS_OUTBOX_IDENTITY,
  groupQueuedThreadMessages,
} from "@t3tools/client-runtime/outbox";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";

const activeIdentityQueuedMessagesAtom = Atom.make((get) => {
  const identityKey = get(managedRelaySessionAtom)?.accountId ?? ANONYMOUS_OUTBOX_IDENTITY;
  const messages = Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
    .flat()
    .filter((message) => (message.identityKey ?? ANONYMOUS_OUTBOX_IDENTITY) === identityKey);
  return groupQueuedThreadMessages(messages);
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:active-identity"));

const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(activeIdentityQueuedMessagesAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("mobile:thread-outbox:shell-statuses"));
// T3-CUSTOM(expbkt3): END

/**
 * Queued pending tasks the outbox drain must not deliver right now: the one
 * open in the new-task editor, plus any whose latest edits could not be saved
 * back yet (delivering those would send stale content). Editing sessions hold
 * their message id here and release it once the queued payload is current.
 */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:editing-message-ids"),
);

export const dispatchingQueuedMessageIdAtom = Atom.make<MessageId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:dispatching-message-id"),
);

export function holdEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next);
}

// T3-CUSTOM(expbkt3): BEGIN — never expose another account's pending work.
export function useThreadOutboxMessages() {
  return useAtomValue(activeIdentityQueuedMessagesAtom);
}
// T3-CUSTOM(expbkt3): END

/**
 * Thread keys (`environmentId:threadId`) of existing threads with a message
 * waiting in the outbox. Creations are excluded: they have no thread row yet
 * and surface as pending tasks instead. Derived once so list builders and
 * reorder planners agree on which settled threads are pulled back to active.
 */
export const queuedThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const [threadKey, queue] of Object.entries(
    get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  )) {
    if (queue.some((message) => message.creation === undefined)) {
      keys.add(threadKey);
    }
  }
  return keys;
}).pipe(Atom.withLabel("mobile:thread-outbox:queued-thread-keys"));

export function useQueuedThreadKeys(): ReadonlySet<string> {
  return useAtomValue(queuedThreadKeysAtom);
}

export function useThreadOutboxShellStatuses() {
  return useAtomValue(threadOutboxShellStatusesAtom);
}
