/**
 * T3-CUSTOM(expbkt3): tell the server which thread this phone has open.
 *
 * The mobile activity heartbeat reports retained background scopes; while the
 * thread route is mounted this retains the `{ type: "thread" }` scope for it,
 * so the server's presence tracker can answer "is the human looking at this
 * session" for the mobile app too. Released on unmount and on thread switch.
 * The app stops reporting altogether when backgrounded, which the server
 * surfaces as a caveat rather than as "away".
 */
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { retainMobileBackgroundScope } from "../../connection/background-activity-scopes";

/** Retains the thread scope for as long as both ids are known. */
export function retainMobileThreadPresence(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): () => void {
  if (environmentId === null || threadId === null || threadId.length === 0) return () => {};
  return retainMobileBackgroundScope(environmentId, {
    type: "thread",
    threadId: ThreadId.make(threadId),
  });
}

export function useThreadPresenceScope(
  environmentId: EnvironmentId | null,
  threadId: string | null,
): void {
  useEffect(() => retainMobileThreadPresence(environmentId, threadId), [environmentId, threadId]);
}
