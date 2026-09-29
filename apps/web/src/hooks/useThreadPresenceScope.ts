/**
 * T3-CUSTOM(expbkt3): tell the server which thread this client has open.
 *
 * Upstream's activity heartbeat already carries a `{ type: "thread" }`
 * background scope, but no client retains one, so the server cannot tell which
 * session the person is looking at. While a thread's chat view is mounted this
 * retains that scope; the next heartbeat (or the scope change itself, which
 * requests one) reports it, and the presence tracker records it as "viewing".
 * Released on unmount and on thread switch.
 *
 * @module hooks/useThreadPresenceScope
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { retainBackgroundScope } from "../lib/backgroundActivityReporter";

export interface ThreadPresenceTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** Retains the thread scope for as long as `target` names a persisted thread. */
export function retainThreadPresence(target: ThreadPresenceTarget | null): () => void {
  if (target === null) return () => {};
  return retainBackgroundScope(target.environmentId, {
    type: "thread",
    threadId: target.threadId,
  });
}

export function useThreadPresenceScope(target: ThreadPresenceTarget | null): void {
  const environmentId = target?.environmentId ?? null;
  const threadId = target?.threadId ?? null;
  useEffect(
    () =>
      retainThreadPresence(
        environmentId === null || threadId === null ? null : { environmentId, threadId },
      ),
    [environmentId, threadId],
  );
}
