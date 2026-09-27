import { EventId, type OrchestrationThreadStreamItem, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

interface MissingThreadSubscriptionInput {
  readonly threadId: ThreadId;
  readonly afterSequence?: number;
}

/**
 * Remembers unavailable thread ids for one WebSocket connection and returns a
 * terminal event that both current and legacy clients already understand.
 */
export function makeMissingThreadSubscriptions() {
  const tombstones = new Map<ThreadId, OrchestrationThreadStreamItem>();

  const get = (threadId: ThreadId) => tombstones.get(threadId);

  const mark = Effect.fn("MissingThreadSubscriptions.mark")(function* (
    input: MissingThreadSubscriptionInput,
  ) {
    const existing = tombstones.get(input.threadId);
    if (existing !== undefined) return existing;

    const occurredAt = DateTime.formatIso(yield* DateTime.now);
    const tombstone = {
      kind: "event" as const,
      event: {
        eventId: EventId.make(`missing-thread:${input.threadId}`),
        sequence: (input.afterSequence ?? -1) + 1,
        occurredAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        aggregateKind: "thread" as const,
        aggregateId: input.threadId,
        type: "thread.deleted" as const,
        payload: {
          threadId: input.threadId,
          deletedAt: occurredAt,
        },
      },
    } satisfies OrchestrationThreadStreamItem;
    tombstones.set(input.threadId, tombstone);
    return tombstone;
  });

  return { get, mark } as const;
}
