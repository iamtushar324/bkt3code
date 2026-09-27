/**
 * T3-CUSTOM(expbkt3): keep the cached thread history inside a size budget.
 *
 * Caching whole conversations is what makes a session readable — and handoffable
 * — while its host is down, but it is also unbounded by nature: every thread the
 * operator opens deepens on its own and nothing ever asked it to stop. This is
 * the part that says stop.
 *
 * The policy is deliberately boring. Threads are evicted least-recently-opened
 * first until the cache fits the budget, and a single enormous thread is dropped
 * rather than allowed to consume it. Three kinds of thread are never evicted:
 * one opened in the last week (the operator is working in it), one pinned by a
 * handoff (its history is the input to work happening elsewhere), and one that
 * is the parent of a thread still cached (evicting it would orphan a lineage the
 * sidebar is drawing). Evicting a thread costs history, never correctness: the
 * next open re-fetches from the host.
 *
 * Sizes are measured from the serialized snapshot the cache already holds, which
 * is exact and free, rather than from a storage estimate that reports the whole
 * origin. They are counted in characters; for the mostly-ASCII JSON stored here
 * that tracks bytes closely enough to budget against.
 *
 * @module connection/threadCacheEviction
 */
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Roughly 200 MB of cached conversation across every environment. */
export const DEFAULT_THREAD_CACHE_TOTAL_BUDGET_CHARS = 200_000_000;
/** Roughly 10 MB for one thread, so a single outlier cannot eat the budget. */
export const DEFAULT_THREAD_CACHE_PER_THREAD_CAP_CHARS = 10_000_000;
/** A thread opened this recently is being worked in; never evict it. */
export const DEFAULT_THREAD_CACHE_PROTECTED_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
/** How long a handoff keeps its source thread's history pinned. */
export const THREAD_CACHE_HANDOFF_PIN_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ThreadCacheMetaRecord {
  readonly environmentId: string;
  readonly threadId: string;
  readonly lastOpenedAtEpochMs: number;
  readonly pinnedUntilEpochMs: number | null;
  readonly sizeChars: number;
}

export interface ThreadCacheEvictionPolicy {
  readonly nowEpochMs: number;
  readonly totalBudgetChars?: number;
  readonly perThreadCapChars?: number;
  readonly protectedWindowMs?: number;
  /** Keys that are the parent of a thread still cached. */
  readonly protectedKeys?: ReadonlySet<string>;
}

export interface ThreadCacheEvictionPlan {
  readonly evictKeys: ReadonlyArray<string>;
  readonly retainedChars: number;
  /** True when the cache is still over budget because everything left is protected. */
  readonly overBudget: boolean;
}

export function threadCacheKey(environmentId: string, threadId: string): string {
  return `${environmentId}:${threadId}`;
}

function isProtected(
  record: ThreadCacheMetaRecord,
  policy: Required<Pick<ThreadCacheEvictionPolicy, "nowEpochMs">> & {
    readonly protectedWindowMs: number;
    readonly protectedKeys: ReadonlySet<string>;
  },
): boolean {
  const key = threadCacheKey(record.environmentId, record.threadId);
  if (policy.protectedKeys.has(key)) {
    return true;
  }
  if (record.pinnedUntilEpochMs !== null && record.pinnedUntilEpochMs > policy.nowEpochMs) {
    return true;
  }
  return policy.nowEpochMs - record.lastOpenedAtEpochMs < policy.protectedWindowMs;
}

/**
 * Choose what to drop. Pure, so the policy can be reasoned about without a
 * database: records in, keys to delete out.
 */
export function selectThreadCacheEvictions(
  records: ReadonlyArray<ThreadCacheMetaRecord>,
  policy: ThreadCacheEvictionPolicy,
): ThreadCacheEvictionPlan {
  const resolved = {
    nowEpochMs: policy.nowEpochMs,
    protectedWindowMs: policy.protectedWindowMs ?? DEFAULT_THREAD_CACHE_PROTECTED_WINDOW_MS,
    protectedKeys: policy.protectedKeys ?? new Set<string>(),
  };
  const totalBudget = policy.totalBudgetChars ?? DEFAULT_THREAD_CACHE_TOTAL_BUDGET_CHARS;
  const perThreadCap = policy.perThreadCapChars ?? DEFAULT_THREAD_CACHE_PER_THREAD_CAP_CHARS;

  const evictKeys: Array<string> = [];
  const survivors: Array<ThreadCacheMetaRecord> = [];
  for (const record of records) {
    const key = threadCacheKey(record.environmentId, record.threadId);
    if (record.sizeChars > perThreadCap && !isProtected(record, resolved)) {
      evictKeys.push(key);
      continue;
    }
    survivors.push(record);
  }

  // Oldest first: the thread the operator has gone longest without opening is
  // the one whose history they are least likely to reach for.
  const byLeastRecentlyOpened = [...survivors].sort(
    (left, right) => left.lastOpenedAtEpochMs - right.lastOpenedAtEpochMs,
  );
  let retainedChars = survivors.reduce((total, record) => total + record.sizeChars, 0);
  for (const record of byLeastRecentlyOpened) {
    if (retainedChars <= totalBudget) {
      break;
    }
    if (isProtected(record, resolved)) {
      continue;
    }
    evictKeys.push(threadCacheKey(record.environmentId, record.threadId));
    retainedChars -= record.sizeChars;
  }

  return { evictKeys, retainedChars, overBudget: retainedChars > totalBudget };
}

function evictionError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local thread cache: ${String(cause)}`,
  });
}

function requestToEffect<A>(
  operation: string,
  run: () => IDBRequest<A>,
): Effect.Effect<A, ConnectionTransientError> {
  return Effect.callback<A, ConnectionTransientError>((resume) => {
    let request: IDBRequest<A>;
    try {
      request = run();
    } catch (cause) {
      resume(Effect.fail(evictionError(operation, cause)));
      return;
    }
    request.addEventListener("error", () => {
      resume(Effect.fail(evictionError(operation, request.error ?? "Unknown IndexedDB error")));
    });
    request.addEventListener("success", () => {
      resume(Effect.succeed(request.result));
    });
  });
}

export const readThreadCacheMeta = Effect.fn("web.threadCacheEviction.readMeta")(function* (
  database: IDBDatabase,
  storeName: string,
) {
  const values = yield* requestToEffect("read", () =>
    database.transaction(storeName, "readonly").objectStore(storeName).getAll(),
  );
  return values.filter(
    (value): value is ThreadCacheMetaRecord =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as ThreadCacheMetaRecord).environmentId === "string" &&
      typeof (value as ThreadCacheMetaRecord).threadId === "string" &&
      typeof (value as ThreadCacheMetaRecord).lastOpenedAtEpochMs === "number",
  );
});

const putThreadCacheMeta = Effect.fn("web.threadCacheEviction.putMeta")(function* (
  database: IDBDatabase,
  storeName: string,
  record: ThreadCacheMetaRecord,
) {
  yield* requestToEffect("write", () =>
    database
      .transaction(storeName, "readwrite")
      .objectStore(storeName)
      .put(record, threadCacheKey(record.environmentId, record.threadId)),
  );
});

const readOneThreadCacheMeta = Effect.fn("web.threadCacheEviction.readOneMeta")(function* (
  database: IDBDatabase,
  storeName: string,
  key: string,
) {
  const value = yield* requestToEffect("read", () =>
    database.transaction(storeName, "readonly").objectStore(storeName).get(key),
  );
  return (value ?? null) as ThreadCacheMetaRecord | null;
});

/** Record that a thread was opened, which is what keeps it out of eviction. */
export const recordThreadOpened = Effect.fn("web.threadCacheEviction.recordThreadOpened")(
  function* (input: {
    readonly database: IDBDatabase;
    readonly storeName: string;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly nowEpochMs: number;
    readonly sizeChars?: number;
  }) {
    const key = threadCacheKey(input.environmentId, input.threadId);
    const existing = yield* readOneThreadCacheMeta(input.database, input.storeName, key);
    yield* putThreadCacheMeta(input.database, input.storeName, {
      environmentId: input.environmentId,
      threadId: input.threadId,
      lastOpenedAtEpochMs: input.nowEpochMs,
      pinnedUntilEpochMs: existing?.pinnedUntilEpochMs ?? null,
      sizeChars: input.sizeChars ?? existing?.sizeChars ?? 0,
    });
  },
);

/**
 * Pin a thread whose history was just used as the input to a handoff. The child
 * work continues elsewhere, so the source transcript has to outlive the
 * operator's attention on it.
 */
export const pinThreadForHandoff = Effect.fn("web.threadCacheEviction.pinThreadForHandoff")(
  function* (input: {
    readonly database: IDBDatabase;
    readonly storeName: string;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly nowEpochMs: number;
  }) {
    const key = threadCacheKey(input.environmentId, input.threadId);
    const existing = yield* readOneThreadCacheMeta(input.database, input.storeName, key);
    yield* putThreadCacheMeta(input.database, input.storeName, {
      environmentId: input.environmentId,
      threadId: input.threadId,
      lastOpenedAtEpochMs: existing?.lastOpenedAtEpochMs ?? input.nowEpochMs,
      pinnedUntilEpochMs: input.nowEpochMs + THREAD_CACHE_HANDOFF_PIN_MS,
      sizeChars: existing?.sizeChars ?? 0,
    });
  },
);

/**
 * Re-measure every cached thread and drop what does not fit.
 *
 * Runs once at startup rather than on every write: eviction is housekeeping,
 * and doing it while the operator is typing buys nothing.
 */
export const sweepThreadCache = Effect.fn("web.threadCacheEviction.sweep")(function* (input: {
  readonly database: IDBDatabase;
  readonly threadStoreName: string;
  readonly metaStoreName: string;
  readonly nowEpochMs: number;
  readonly totalBudgetChars?: number;
  readonly perThreadCapChars?: number;
}) {
  const [keys, values, meta] = yield* Effect.all([
    requestToEffect("read", () =>
      input.database
        .transaction(input.threadStoreName, "readonly")
        .objectStore(input.threadStoreName)
        .getAllKeys(),
    ),
    requestToEffect("read", () =>
      input.database
        .transaction(input.threadStoreName, "readonly")
        .objectStore(input.threadStoreName)
        .getAll(),
    ),
    readThreadCacheMeta(input.database, input.metaStoreName),
  ]);

  const metaByKey = new Map(
    meta.map((record) => [threadCacheKey(record.environmentId, record.threadId), record]),
  );
  const records: Array<ThreadCacheMetaRecord> = [];
  const parentKeys = new Set<string>();
  for (const [index, rawKey] of keys.entries()) {
    const key = String(rawKey);
    const raw = values[index];
    if (typeof raw !== "string") {
      continue;
    }
    const separator = key.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const environmentId = key.slice(0, separator);
    const threadId = key.slice(separator + 1);
    const existing = metaByKey.get(key);
    records.push({
      environmentId,
      threadId,
      // A thread cached before this bookkeeping existed sorts oldest, which is
      // the safe default: it is also the one nobody has opened since.
      lastOpenedAtEpochMs: existing?.lastOpenedAtEpochMs ?? 0,
      pinnedUntilEpochMs: existing?.pinnedUntilEpochMs ?? null,
      sizeChars: raw.length,
    });
    const parent = cachedParentRefOf(raw);
    if (parent !== null) {
      // A parent on another machine is cached under that machine's key, so the
      // lineage is only protected if we look for it there.
      parentKeys.add(threadCacheKey(parent.environmentId ?? environmentId, parent.threadId));
    }
  }

  const plan = selectThreadCacheEvictions(records, {
    nowEpochMs: input.nowEpochMs,
    protectedKeys: parentKeys,
    ...(input.totalBudgetChars === undefined ? {} : { totalBudgetChars: input.totalBudgetChars }),
    ...(input.perThreadCapChars === undefined
      ? {}
      : { perThreadCapChars: input.perThreadCapChars }),
  });

  for (const key of plan.evictKeys) {
    yield* requestToEffect("remove", () =>
      input.database
        .transaction(input.threadStoreName, "readwrite")
        .objectStore(input.threadStoreName)
        .delete(key),
    );
    yield* requestToEffect("remove", () =>
      input.database
        .transaction(input.metaStoreName, "readwrite")
        .objectStore(input.metaStoreName)
        .delete(key),
    );
  }

  // Refresh sizes so the next sweep starts from measured records rather than
  // re-deriving every one of them.
  for (const record of records) {
    const key = threadCacheKey(record.environmentId, record.threadId);
    if (plan.evictKeys.includes(key)) {
      continue;
    }
    yield* putThreadCacheMeta(input.database, input.metaStoreName, record);
  }

  return plan;
});

export interface CachedParentRef {
  readonly threadId: string;
  /** Null when the parent is on the same environment as the cached thread. */
  readonly environmentId: string | null;
}

/**
 * The parent this cached snapshot names, read without decoding the whole
 * snapshot — the sweep only needs to know which threads a lineage still points
 * at, and full decoding of every cached thread would be the expensive part of
 * an otherwise cheap sweep.
 *
 * The environment comes along because a lineage can cross machines, and a
 * parent key built from the wrong environment protects nothing.
 */
export function cachedParentRefOf(rawSnapshot: string): CachedParentRef | null {
  const threadId = /"parentThreadId"\s*:\s*"([^"]+)"/.exec(rawSnapshot)?.[1];
  if (threadId === undefined) {
    return null;
  }
  const environmentId = /"parentEnvironmentId"\s*:\s*"([^"]+)"/.exec(rawSnapshot)?.[1] ?? null;
  return { threadId, environmentId };
}
