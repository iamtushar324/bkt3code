// T3-CUSTOM(expbkt3): in-process record of which queued turns this client has
// already put on the wire.
//
// `dispatchPersistedOutboxItem` was written when a duplicate dispatch was
// harmless: the server deduplicates by commandId, so a queue row that outlived
// its acknowledgement cost nothing to send twice. Since upstream #8048 that is
// no longer true. The web client uploads an image before sending and references
// it by a `pending-…` id, then releases that upload as soon as the turn is
// acknowledged. A second dispatch is normalized before any commandId dedup,
// finds the pending upload gone, and fails with "attachment not found (removed
// or expired)" — marking a turn that actually ran as failed.
//
// A replay loop cannot tell the difference on its own: its send gate clears on
// the server's projection acknowledgement, which races ahead of both the RPC
// reply and the queue-row removal. This registry is the missing signal.

/** Bounded so a long-lived tab cannot grow the delivered set without limit. */
const DELIVERED_HISTORY_LIMIT = 256;

const inFlightDeliveries = new Set<string>();
const deliveredDeliveries = new Set<string>();

export interface ThreadOutboxDeliveryRef {
  readonly environmentId: string;
  readonly identityKey: string | undefined;
  readonly messageId: string;
}

export function threadOutboxDeliveryKey(ref: ThreadOutboxDeliveryRef): string {
  return `${ref.identityKey ?? ""} ${ref.environmentId} ${ref.messageId}`;
}

export function beginThreadOutboxDelivery(key: string): void {
  inFlightDeliveries.add(key);
}

/**
 * Records the outcome of a dispatch. A delivered turn stays remembered so a
 * queue row that outlived its removal is recognised as stale; a failed one is
 * forgotten so retry and reconnect replay still work.
 */
export function settleThreadOutboxDelivery(key: string, delivered: boolean): void {
  inFlightDeliveries.delete(key);
  if (!delivered) {
    return;
  }
  deliveredDeliveries.add(key);
  while (deliveredDeliveries.size > DELIVERED_HISTORY_LIMIT) {
    const oldest = deliveredDeliveries.values().next();
    if (oldest.done === true) {
      return;
    }
    deliveredDeliveries.delete(oldest.value);
  }
}

/** This turn is on the wire right now — leave its queue row to the dispatch that owns it. */
export function isThreadOutboxDeliveryInFlight(ref: ThreadOutboxDeliveryRef): boolean {
  return inFlightDeliveries.has(threadOutboxDeliveryKey(ref));
}

/** This turn was acknowledged, so its queue row is stale and must be discarded, not replayed. */
export function isThreadOutboxDeliveryDelivered(ref: ThreadOutboxDeliveryRef): boolean {
  return deliveredDeliveries.has(threadOutboxDeliveryKey(ref));
}

/** Test seam: the registry is module state shared by every caller in the app. */
export function resetThreadOutboxDeliveries(): void {
  inFlightDeliveries.clear();
  deliveredDeliveries.clear();
}

interface ReplayCandidate {
  readonly environmentId: string;
  readonly identityKey?: string | undefined;
  readonly messageId: string;
  readonly deliveryState?: string | undefined;
  readonly createdAt: string;
}

/**
 * Splits the queue into the rows a replay loop should drop and the single row it
 * should send next. Stale rows are discarded rather than skipped: a row left in
 * place keeps the composer latched as busy for as long as it survives.
 */
export function selectThreadOutboxReplay<Item extends ReplayCandidate>(input: {
  readonly items: ReadonlyArray<Item>;
  readonly identityKey: string;
  /** Rows the replay loop itself already has on the wire. */
  readonly replayingMessageIds: ReadonlySet<string>;
}): { readonly stale: ReadonlyArray<Item>; readonly next: Item | undefined } {
  const stale: Item[] = [];
  const sendable: Item[] = [];
  for (const item of input.items) {
    if (item.deliveryState === "failed") {
      continue;
    }
    const ref = {
      environmentId: item.environmentId,
      identityKey: item.identityKey ?? input.identityKey,
      messageId: item.messageId,
    };
    if (isThreadOutboxDeliveryDelivered(ref)) {
      stale.push(item);
      continue;
    }
    if (input.replayingMessageIds.has(item.messageId) || isThreadOutboxDeliveryInFlight(ref)) {
      continue;
    }
    sendable.push(item);
  }
  // Oldest first: IndexedDB iterates by messageId (a random UUID), so an
  // unsorted pick would flush the queue in arbitrary order.
  return {
    stale,
    next: sendable.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(0),
  };
}
