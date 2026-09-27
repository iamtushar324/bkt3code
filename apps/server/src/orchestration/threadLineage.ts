// T3-CUSTOM(expbkt3): session lineage invariants.
//
// Lineage must stay a FOREST. Every writer of `parentThreadId` — the decider's
// thread.meta.update case and the MCP create handler — resolves ancestry
// through this module so the rule has exactly one definition and one error
// message. Without it, `A.parent = B; B.parent = A` is two individually valid
// commands that together strand both threads: neither can ever reach a root,
// so neither can ever render.
import type {
  OrchestrationCommand,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

/**
 * Backstop for a projection that is already corrupt. A pre-existing cycle
 * would otherwise spin the ancestor walk forever; hitting the cap is reported
 * as a cycle rather than silently accepted.
 */
export const THREAD_LINEAGE_MAX_DEPTH = 32;

function parentOf(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
): ThreadId | null {
  return threads.find((thread) => thread.id === threadId)?.parentThreadId ?? null;
}

/**
 * Walk from `parentThreadId` towards its root, looking for `threadId`. A hit
 * means the proposed parent is the thread itself or one of its descendants,
 * so accepting the link would close a loop.
 */
export function threadLineageWouldCycle(input: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
}): boolean {
  if (input.threadId === input.parentThreadId) return true;

  const seen = new Set<string>([input.threadId]);
  let cursor: ThreadId | null = input.parentThreadId;
  for (let depth = 0; cursor !== null && depth < THREAD_LINEAGE_MAX_DEPTH; depth += 1) {
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = parentOf(input.threads, cursor);
  }
  return cursor !== null;
}

/**
 * Every thread reachable downwards from `threadId`, excluding itself. The
 * "move under session" picker uses this to hide the options the decider would
 * reject, so an invalid parent is never offered in the first place.
 */
export function collectThreadDescendants(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
): ReadonlySet<ThreadId> {
  const descendants = new Set<ThreadId>();
  const queue: ThreadId[] = [threadId];
  // Bounded by the thread count: each id is enqueued at most once, so a
  // corrupt cycle cannot make this loop forever.
  while (queue.length > 0) {
    const current = queue.pop() as ThreadId;
    for (const thread of threads) {
      if (thread.parentThreadId !== current) continue;
      if (thread.id === threadId || descendants.has(thread.id)) continue;
      descendants.add(thread.id);
      queue.push(thread.id);
    }
  }
  return descendants;
}

export function requireThreadLineageAcyclic(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (
    !threadLineageWouldCycle({
      threads: input.readModel.threads,
      threadId: input.threadId,
      parentThreadId: input.parentThreadId,
    })
  ) {
    return Effect.void;
  }
  return Effect.fail(
    new OrchestrationCommandInvariantError({
      commandType: input.command.type,
      detail:
        input.threadId === input.parentThreadId
          ? `Thread '${input.threadId}' cannot be its own parent.`
          : `Thread '${input.parentThreadId}' is a descendant of '${input.threadId}', so parenting would create a cycle.`,
    }),
  );
}
