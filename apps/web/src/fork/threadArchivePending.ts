// T3-CUSTOM(expbkt3): archive progress shared by every web archive entry point.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

// Keep environment and thread IDs separate even when an ID contains a colon.
function archiveKey(threadRef: ScopedThreadRef): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId]);
}

export const useThreadArchivePendingStore = create<{
  readonly pendingKeys: ReadonlySet<string>;
}>(() => ({ pendingKeys: new Set() }));

export function isThreadArchivePending(threadRef: ScopedThreadRef): boolean {
  return useThreadArchivePendingStore.getState().pendingKeys.has(archiveKey(threadRef));
}

export function useThreadArchivePending(threadRef: ScopedThreadRef): boolean {
  const key = archiveKey(threadRef);
  return useThreadArchivePendingStore((state) => state.pendingKeys.has(key));
}

const archiveRequests = new Map<string, Promise<unknown>>();

/** Claim synchronously so even a second click before React renders cannot dispatch twice. */
export function runWithThreadArchivePending<A>(
  threadRef: ScopedThreadRef,
  archive: () => Promise<A>,
): Promise<A> {
  const key = archiveKey(threadRef);
  const existing = archiveRequests.get(key);
  if (existing) return existing as Promise<A>;
  // Defer the callback until the shared promise is registered, including reentrant callers.
  const request = Promise.resolve()
    .then(archive)
    .finally(() => {
      archiveRequests.delete(key);
      useThreadArchivePendingStore.setState((state) => {
        const pendingKeys = new Set(state.pendingKeys);
        pendingKeys.delete(key);
        return { pendingKeys };
      });
    });
  archiveRequests.set(key, request);
  useThreadArchivePendingStore.setState((state) => ({
    pendingKeys: new Set([...state.pendingKeys, key]),
  }));
  return request;
}
