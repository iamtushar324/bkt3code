import type { OrchestrationCommand, UserId } from "@t3tools/contracts";

/**
 * Selects the actor persisted by thread creation dispatched through HTTP.
 * Authenticated users always win; only actorless trusted callers may delegate ownership.
 */
export const resolveDelegatedThreadOwner = (
  command: OrchestrationCommand,
  authenticatedActorUserId: UserId | null,
): UserId | null => {
  if (authenticatedActorUserId !== null) {
    return authenticatedActorUserId;
  }

  if (command.type === "thread.create") {
    return command.ownerUserId ?? null;
  }

  if (command.type === "thread.turn.start") {
    return command.bootstrap?.createThread?.ownerUserId ?? null;
  }

  return null;
};
