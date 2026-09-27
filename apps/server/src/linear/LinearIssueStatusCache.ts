/**
 * T3-CUSTOM(expbkt3): one upstream read per issue, however many people are looking.
 *
 * The sidebar re-requests every visible issue once a minute, per open client.
 * The resolver underneath it had no cache and no coalescing, so the cost was
 * multiplied by every viewer and every browser tab: two people with the sidebar
 * open on thirty tagged threads were fifty upstream reads a minute, for data
 * that is identical for all of them and changes a few times a day.
 *
 * Issue status is workspace-global — it does not vary by viewer — so it caches
 * cleanly. This holds a short-lived entry per identifier and a Deferred per
 * in-flight identifier, so concurrent callers asking for the same issue wait on
 * one read instead of starting their own.
 *
 * Two properties make that safe to sit in front of a slow upstream, and both
 * exist because of an outage rather than by design:
 *
 * 1. **The read is detached from the caller that started it.** The sidebar
 *    refreshes on a timer and interrupts the request it replaces, so a read
 *    owned by the requesting fiber is cancelled roughly once a minute. That
 *    stranded the identifier in `inflight` behind a Deferred nobody would ever
 *    complete, and every later caller then waited on it forever — a permanent
 *    hang, one whole request slot per viewer, re-armed every minute.
 * 2. **A known status is served immediately and refreshed behind the answer.**
 *    The TTL is shorter than the refresh interval, so without this every single
 *    refresh was a cold read of every visible issue and paid the upstream's full
 *    latency in the foreground. Only an issue this process has never resolved
 *    blocks now.
 */
import type { LinearIssueStatusSummary } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Slightly under the sidebar's own 55s stale time, so a client refreshing on the
 * minute boundary triggers a re-read rather than being handed an entry that is
 * about to expire anyway. Past it the entry is still served — it just stops
 * being authoritative and a refresh runs behind it.
 */
export const DEFAULT_STATUS_TTL_MS = 50_000;

/**
 * Failures expire fast. A misconfigured credential or a bridge that is briefly
 * down should not pin "unavailable" on a row for a full minute after it starts
 * working again — but retrying every single request would hammer whatever is
 * already failing.
 */
export const DEFAULT_ERROR_TTL_MS = 5_000;

/**
 * How long past its TTL an answer stays good enough to hand back while a fresh
 * read runs. Issue status changes a few times a day, so a value this old is
 * still almost always right — and it is unconditionally better than making the
 * sidebar wait on an upstream that is having a bad morning. Past this the entry
 * is dropped and the next caller blocks on a real read.
 */
export const DEFAULT_STALE_SERVE_MS = 10 * 60_000;

interface CacheEntry {
  readonly summary: LinearIssueStatusSummary;
  readonly expiresAt: number;
}

interface CacheState {
  readonly entries: Map<string, CacheEntry>;
  readonly inflight: Map<string, Deferred.Deferred<LinearIssueStatusSummary>>;
}

export interface LinearIssueStatusCacheOptions {
  readonly ttlMs?: number;
  readonly errorTtlMs?: number;
  readonly staleServeMs?: number;
  /** Guards against a pathological identifier set pinning memory indefinitely. */
  readonly maxEntries?: number;
}

export interface LinearIssueStatusCache {
  /**
   * Resolves every identifier, calling `fetchMissing` at most once for the ones
   * this call is responsible for. Identifiers already being fetched by another
   * caller are awaited, not re-fetched, and an identifier with a recent answer
   * is returned straight away while its re-read runs detached. Only an
   * identifier with no answer at all makes the caller wait.
   */
  readonly resolve: (
    identifiers: ReadonlyArray<string>,
    fetchMissing: (
      missing: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<LinearIssueStatusSummary>>,
  ) => Effect.Effect<ReadonlyArray<LinearIssueStatusSummary>>;
}

const MAX_ENTRIES = 500;

export const makeLinearIssueStatusCache = (
  options: LinearIssueStatusCacheOptions = {},
): Effect.Effect<LinearIssueStatusCache> =>
  Effect.gen(function* () {
    const ttlMs = options.ttlMs ?? DEFAULT_STATUS_TTL_MS;
    const errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS;
    const staleServeMs = options.staleServeMs ?? DEFAULT_STALE_SERVE_MS;
    const maxEntries = options.maxEntries ?? MAX_ENTRIES;
    const state = yield* SynchronizedRef.make<CacheState>({
      entries: new Map(),
      inflight: new Map(),
    });

    const prune = (entries: Map<string, CacheEntry>, now: number) => {
      // Expired is not the same as useless: a known status stays around past its
      // TTL so it can be served while its replacement is read. "Unavailable" is
      // not a status, so it goes the moment it expires.
      for (const [key, entry] of entries) {
        const keepUntil = entry.expiresAt + (entry.summary.error === null ? staleServeMs : 0);
        if (keepUntil <= now) entries.delete(key);
      }
      // Oldest-expiry first, so a burst of one-off identifiers cannot evict the
      // rows the sidebar actually keeps asking for.
      if (entries.size > maxEntries) {
        const ordered = [...entries].sort((left, right) => left[1].expiresAt - right[1].expiresAt);
        for (const [key] of ordered.slice(0, entries.size - maxEntries)) entries.delete(key);
      }
    };

    const unavailable = (identifier: string): LinearIssueStatusSummary => ({
      identifier,
      url: null,
      status: null,
      statusType: null,
      updatedAt: null,
      error: "Linear status is temporarily unavailable.",
    });

    /**
     * Drops claims this read never answered. Completing an already-completed
     * Deferred is a no-op and the in-flight entries are matched by identity, so
     * running this after a clean settle costs nothing; it earns its place when
     * the read is torn down from outside and never reaches its own settle.
     */
    const release = (claimed: ReadonlyMap<string, Deferred.Deferred<LinearIssueStatusSummary>>) =>
      Effect.gen(function* () {
        yield* SynchronizedRef.update(state, (current) => {
          const inflight = new Map(current.inflight);
          for (const [identifier, deferred] of claimed) {
            // Only ours. A later read may already hold this identifier.
            if (inflight.get(identifier) === deferred) inflight.delete(identifier);
          }
          return { entries: current.entries, inflight };
        });
        for (const [identifier, deferred] of claimed) {
          yield* Deferred.succeed(deferred, unavailable(identifier));
        }
      });

    const settle = (
      claimed: ReadonlyMap<string, Deferred.Deferred<LinearIssueStatusSummary>>,
      fetchMissing: (
        missing: ReadonlyArray<string>,
      ) => Effect.Effect<ReadonlyArray<LinearIssueStatusSummary>>,
    ) =>
      Effect.gen(function* () {
        const missing = [...claimed.keys()];
        const fetched = yield* fetchMissing(missing).pipe(
          Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<LinearIssueStatusSummary>)),
        );
        const bySummary = new Map(fetched.map((summary) => [summary.identifier, summary]));
        const completedAt = yield* Clock.currentTimeMillis;
        const settled = [...claimed.keys()].map((identifier) => {
          const summary = bySummary.get(identifier) ?? unavailable(identifier);
          const lifetime = summary.error === null ? ttlMs : errorTtlMs;
          return [identifier, { summary, expiresAt: completedAt + lifetime }] as const;
        });
        // Publish before waking anyone. A caller that resumes while its own
        // identifier is still listed as in-flight would queue behind a read that
        // has already finished.
        yield* SynchronizedRef.update(state, (current) => {
          const entries = new Map(current.entries);
          const inflight = new Map(current.inflight);
          for (const [identifier, entry] of settled) {
            entries.set(identifier, entry);
            if (inflight.get(identifier) === claimed.get(identifier)) inflight.delete(identifier);
          }
          prune(entries, completedAt);
          return { entries, inflight };
        });
        for (const [identifier, entry] of settled) {
          yield* Deferred.succeed(claimed.get(identifier)!, entry.summary);
        }
      }).pipe(
        // A claim outliving its read is the whole failure mode, so releasing it
        // cannot itself be skippable: an interrupted fiber abandons its next
        // asynchronous step, which would strand exactly what this is here to
        // free.
        Effect.onExit(() => Effect.uninterruptible(release(claimed))),
      );

    const resolve: LinearIssueStatusCache["resolve"] = (identifiers, fetchMissing) =>
      Effect.gen(function* () {
        const wanted = [...new Set(identifiers)];
        if (wanted.length === 0) return [];
        const now = yield* Clock.currentTimeMillis;

        const fresh = new Map<string, LinearIssueStatusSummary>();
        const awaited = new Map<string, Deferred.Deferred<LinearIssueStatusSummary>>();
        const claimed = new Map<string, Deferred.Deferred<LinearIssueStatusSummary>>();

        yield* SynchronizedRef.updateEffect(state, (current) =>
          Effect.gen(function* () {
            const entries = new Map(current.entries);
            const inflight = new Map(current.inflight);
            prune(entries, now);
            for (const identifier of wanted) {
              const entry = entries.get(identifier);
              if (entry && entry.expiresAt > now) {
                fresh.set(identifier, entry.summary);
                continue;
              }
              // Expired but still here: answer with it and let the re-read run
              // behind the answer, so a refresh never pays upstream latency for
              // an issue this process has already resolved once. Only a real
              // status qualifies — a stale "unavailable" is worth nothing.
              const servable = entry !== undefined && entry.summary.error === null;
              if (servable) fresh.set(identifier, entry.summary);
              const pending = inflight.get(identifier);
              if (pending) {
                if (!servable) awaited.set(identifier, pending);
                continue;
              }
              const deferred = yield* Deferred.make<LinearIssueStatusSummary>();
              inflight.set(identifier, deferred);
              claimed.set(identifier, deferred);
            }
            return { entries, inflight };
          }),
        );

        if (claimed.size > 0) {
          // Detached on purpose. This caller is one of several viewers and is
          // interrupted by its own next refresh; the read has to outlive it, or
          // the claim is stranded and everyone behind it waits forever.
          yield* Effect.forkDetach(settle(claimed, fetchMissing), { startImmediately: true });
        }

        for (const [identifier, deferred] of claimed) {
          if (fresh.has(identifier)) continue;
          fresh.set(identifier, yield* Deferred.await(deferred));
        }
        for (const [identifier, deferred] of awaited) {
          fresh.set(identifier, yield* Deferred.await(deferred));
        }

        return wanted.map((identifier) => fresh.get(identifier)!);
      });

    return { resolve };
  });

/**
 * The process-wide instance. The fork's RPC handler map is rebuilt per
 * connection, so a cache constructed there would collapse a single client's
 * tabs and nothing else — and the multiplication this exists to remove is
 * across viewers. Memoised here rather than threaded through the runtime so
 * the change costs no edit to an upstream-owned file.
 */
let shared: LinearIssueStatusCache | undefined;

export const sharedLinearIssueStatusCache = (): Effect.Effect<LinearIssueStatusCache> =>
  Effect.suspend(() =>
    shared === undefined
      ? makeLinearIssueStatusCache().pipe(
          Effect.tap((cache) =>
            Effect.sync(() => {
              shared = cache;
            }),
          ),
        )
      : Effect.succeed(shared),
  );

/** Test-only: drops the process-wide instance so suites cannot leak into each other. */
export const resetSharedLinearIssueStatusCache = (): void => {
  shared = undefined;
};
