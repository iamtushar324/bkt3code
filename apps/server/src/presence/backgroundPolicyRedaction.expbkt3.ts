/**
 * T3-CUSTOM(expbkt3): keep other people's open threads out of the background
 * policy RPCs.
 *
 * Upstream's `server.getBackgroundPolicy` and `subscribeBackgroundPolicy`
 * return every client lease with its scopes. Now that clients retain a
 * `thread` scope for the session they have open, that would tell any
 * read-scoped client which session every other user is looking at. A caller
 * keeps the thread scopes of its own login; everyone else's are dropped. The
 * aggregate `activeScopeKeys` is filtered the same way, so nothing leaks
 * through the summary either.
 */
import type { AuthSessionId, BackgroundPolicySnapshot } from "@t3tools/contracts";

export function redactBackgroundPolicySnapshot(
  snapshot: BackgroundPolicySnapshot,
  currentSessionId: AuthSessionId,
): BackgroundPolicySnapshot {
  const foreign = snapshot.leases.some(
    (lease) =>
      lease.sessionId !== currentSessionId && lease.scopes.some((scope) => scope.type === "thread"),
  );
  if (!foreign) return snapshot;
  const ownThreadKeys = new Set<string>();
  const leases = snapshot.leases.map((lease) => {
    if (lease.sessionId === currentSessionId) {
      for (const scope of lease.scopes) {
        if (scope.type === "thread") ownThreadKeys.add(`thread:${scope.threadId}`);
      }
      return lease;
    }
    return { ...lease, scopes: lease.scopes.filter((scope) => scope.type !== "thread") };
  });
  return {
    ...snapshot,
    leases,
    activeScopeKeys: snapshot.activeScopeKeys.filter(
      (key) => !key.startsWith("thread:") || ownThreadKeys.has(key),
    ),
  };
}
