// T3-CUSTOM(expbkt3): a released provider session settles the subagents it leaves open.
import type {
  NodeId,
  OrchestrationV2DomainEvent,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { EventSinkV2Shape } from "./EventSink.ts";
import type { IdAllocatorV2Shape } from "@t3tools/provider-core/server/IdAllocator";
import type { ProjectionRuntimeRecoveryState, ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import type { ProviderSessionReleaseReason } from "./ProviderSessionManager.ts";

type TurnItem = OrchestrationV2ThreadProjection["turnItems"][number];
type ExecutionNode = OrchestrationV2ThreadProjection["nodes"][number];

export interface ReleasedSessionSubagentsInput {
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly idAllocator: IdAllocatorV2Shape;
  readonly eventSink: EventSinkV2Shape;
  readonly providerSessionId: ProviderSessionId;
  readonly reason: ProviderSessionReleaseReason;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  /** The app threads the released process served. */
  readonly threadIds: Iterable<ThreadId>;
  /** App threads a live session still serves. That session owns their subagents. */
  readonly liveThreadIds: Effect.Effect<ReadonlySet<ThreadId>>;
  /** Work that started after the release belongs to a later session. */
  readonly releasedAt: DateTime.Utc;
}

const isOpenStatus = (status: string): boolean =>
  status === "pending" || status === "running" || status === "waiting";

/** Same as startup recovery: a closed card also closes its form and stops streaming. */
const cancelledItem = (item: TurnItem, now: DateTime.Utc): TurnItem =>
  item.type === "secret_request" && item.secretStatus === "pending"
    ? { ...item, status: "cancelled", secretStatus: "cancelled", completedAt: now, updatedAt: now }
    : {
        ...item,
        status: "cancelled",
        completedAt: now,
        updatedAt: now,
        ...(item.type === "reasoning" || item.type === "assistant_message"
          ? { streaming: false }
          : {}),
      };

/**
 * Settles the provider-native subagents a released provider session leaves open.
 *
 * A subagent runs inside its parent's provider process. When that process goes
 * away between turns (an account rebalance or mode change, a hard limit, a
 * crash), nothing reports the subagent's end: its record, the parent's card and
 * its child thread stay running until a server restart. Startup recovery
 * (ProviderRuntimeRecoveryService) settles them after a restart; this settles
 * them for one released session, with the same events and the same reads.
 *
 * Only open `provider_native` subagents of the released driver and instance,
 * started at or before the release, are settled. A delegate_task child has its
 * own runs and is never touched, and neither is a thread a live session still
 * serves. A later SendMessage resume reopens a settled subagent: its new events
 * overwrite the cancelled status.
 *
 * A server shutdown is left to startup recovery, which also wakes a settled
 * run whose background work the restart cancelled; settled here, that work
 * would no longer look lost to it.
 *
 * Never fails: the release must complete either way, and startup recovery is
 * the fallback for a write that did not land.
 */
export const settleReleasedSessionSubagents = (
  input: ReleasedSessionSubagentsInput,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (input.reason === "server_shutdown") return;
    const liveThreadIds = yield* input.liveThreadIds;
    const now = yield* DateTime.now;
    const events: Array<OrchestrationV2DomainEvent> = [];
    const settledSubagentIds: Array<NodeId> = [];
    const allocateEventId = (threadId: ThreadId) =>
      input.idAllocator.allocate.event({ threadId, providerSessionId: input.providerSessionId });
    const startedByRelease = (startedAt: DateTime.Utc | null, fallback: DateTime.Utc | null) => {
      const at = startedAt ?? fallback;
      return at === null || DateTime.isLessThanOrEqualTo(at, input.releasedAt);
    };
    const ranInReleasedSession = (
      subagent: OrchestrationV2Subagent,
      projection: ProjectionRuntimeRecoveryState,
    ) => {
      if (
        subagent.origin !== "provider_native" ||
        !isOpenStatus(subagent.status) ||
        subagent.driver !== input.driver ||
        subagent.providerInstanceId !== input.providerInstanceId ||
        !startedByRelease(subagent.startedAt, subagent.updatedAt)
      ) {
        return false;
      }
      // Claude subagents carry no provider thread; their parent thread's
      // attachment is the link. One that does must not name another session.
      if (subagent.providerThreadId === null) return true;
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === subagent.providerThreadId,
      );
      // The recovery read loads only live-looking provider threads: one it did
      // not load may belong to another shared session that still runs it.
      return (
        providerThread !== undefined &&
        (providerThread.providerSessionId == null ||
          providerThread.providerSessionId === input.providerSessionId)
      );
    };

    const settleNode = Effect.fnUntraced(function* (node: ExecutionNode) {
      events.push({
        id: yield* allocateEventId(node.threadId),
        type: "node.updated",
        threadId: node.threadId,
        ...(node.runId === null ? {} : { runId: node.runId }),
        nodeId: node.id,
        driver: input.driver,
        providerInstanceId: input.providerInstanceId,
        occurredAt: now,
        payload: { ...node, status: "cancelled", completedAt: now },
      });
    });
    const settleItem = Effect.fnUntraced(function* (item: TurnItem) {
      events.push({
        id: yield* allocateEventId(item.threadId),
        type: "turn-item.updated",
        threadId: item.threadId,
        ...(item.runId === null ? {} : { runId: item.runId }),
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        driver: input.driver,
        providerInstanceId: input.providerInstanceId,
        occurredAt: now,
        payload: cancelledItem(item, now),
      });
    });

    /**
     * Settles one thread's subagents, and for a provider-native child thread its
     * runless root turn and the items under it. Returns the child threads of the
     * subagents it settled, whose own work died with the same process.
     */
    const settleThread = Effect.fnUntraced(function* (threadId: ThreadId, isChild: boolean) {
      // Most releases (idle ones) leave nothing open. The subagent rows alone
      // are cheap; the recovery read below can take seconds on a cold cache
      // for a thread with thousands of items, on the event loop. A failed
      // check falls through to the full read.
      if (!isChild) {
        const records = yield* input.projectionStore
          .getThreadRecords(threadId, ["subagents"])
          .pipe(Effect.option);
        if (
          records._tag === "Some" &&
          !records.value.subagents.some(
            (subagent) =>
              subagent.origin === "provider_native" &&
              isOpenStatus(subagent.status) &&
              subagent.driver === input.driver &&
              subagent.providerInstanceId === input.providerInstanceId,
          )
        ) {
          return [];
        }
      }
      // The thread's open subagents, nodes and items, as startup recovery reads them.
      const projection = yield* input.projectionStore
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }));
      // A deleted thread has nothing left to show as running.
      if (projection === null) return [];
      const settledNodeIds = new Set<string>();
      const settledItemIds = new Set<string>();
      const childThreadIds: Array<ThreadId> = [];
      for (const subagent of projection.subagents) {
        if (!ranInReleasedSession(subagent, projection)) continue;
        settledSubagentIds.push(subagent.id);
        events.push({
          id: yield* allocateEventId(subagent.threadId),
          type: "subagent.updated",
          threadId: subagent.threadId,
          ...(subagent.runId === null ? {} : { runId: subagent.runId }),
          nodeId: subagent.id,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          occurredAt: now,
          payload: { ...subagent, status: "cancelled", completedAt: now, updatedAt: now },
        });
        // The parent's card for this subagent.
        for (const item of projection.turnItems) {
          if (
            item.type !== "subagent" ||
            item.subagentId !== subagent.id ||
            !isOpenStatus(item.status) ||
            settledItemIds.has(item.id)
          ) {
            continue;
          }
          settledItemIds.add(item.id);
          yield* settleItem(item);
        }
        const node = projection.nodes.find(
          (candidate) => candidate.id === subagent.id && isOpenStatus(candidate.status),
        );
        if (node !== undefined && !settledNodeIds.has(node.id)) {
          settledNodeIds.add(node.id);
          yield* settleNode(node);
        }
        if (subagent.childThreadId !== null) childThreadIds.push(subagent.childThreadId);
      }
      if (isChild) {
        // A provider-native child thread has no runs: its work is a runless root
        // turn (shown as Working) and the items under it.
        for (const node of projection.nodes) {
          if (
            node.kind !== "root_turn" ||
            node.runId !== null ||
            !isOpenStatus(node.status) ||
            settledNodeIds.has(node.id) ||
            !startedByRelease(node.startedAt, null)
          ) {
            continue;
          }
          settledNodeIds.add(node.id);
          yield* settleNode(node);
          for (const item of projection.turnItems) {
            if (
              item.nodeId !== node.id ||
              item.runId !== null ||
              !isOpenStatus(item.status) ||
              settledItemIds.has(item.id)
            ) {
              continue;
            }
            settledItemIds.add(item.id);
            yield* settleItem(item);
          }
        }
      }
      return childThreadIds;
    });

    const visited = new Set<ThreadId>();
    let pending: Array<{ readonly threadId: ThreadId; readonly isChild: boolean }> = [];
    for (const threadId of input.threadIds) {
      if (!liveThreadIds.has(threadId)) pending.push({ threadId, isChild: false });
    }
    while (pending.length > 0) {
      const next: typeof pending = [];
      for (const { threadId, isChild } of pending) {
        if (visited.has(threadId)) continue;
        visited.add(threadId);
        const childThreadIds = yield* settleThread(threadId, isChild);
        for (const childThreadId of childThreadIds) {
          if (!liveThreadIds.has(childThreadId))
            next.push({ threadId: childThreadId, isChild: true });
        }
      }
      pending = next;
    }

    if (events.length === 0) return;
    yield* input.eventSink.write({ events });
    yield* Effect.logInfo("orchestration-v2.provider-session-release-subagents-cancelled", {
      providerSessionId: input.providerSessionId,
      subagentIds: settledSubagentIds,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("orchestration-v2.provider-session-release-subagents-failed", {
            providerSessionId: input.providerSessionId,
            cause: Cause.pretty(cause),
          }),
    ),
  );
