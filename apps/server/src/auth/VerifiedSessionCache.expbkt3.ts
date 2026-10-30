/**
 * In-memory read-through cache of `auth_sessions` rows for `SessionStore`.
 *
 * Every authenticated HTTP request and every WebSocket connect used to read the
 * session row from SQLite; under a reconnect storm that was ~10k primary-key
 * reads in 50 minutes, half of them queued for a reader connection. The cache
 * keeps a row for 60 s and an unknown id for 10 s.
 *
 * The cache never decides whether a session is valid: callers still check
 * `revokedAt` and `expiresAt` on every hit. Revocation stays instant because
 * `SessionStore` invalidates synchronously after each committed write and
 * before it publishes the change. A write made by another process (the
 * `t3 auth session revoke` CLI) reaches this server within the 60 s TTL.
 *
 * Race guard: a read that started before an invalidation must not store the
 * row it read. `generation()` is taken before the read and `fill` drops the
 * row when any invalidation or patch ran in between.
 *
 * @module VerifiedSessionCache
 */
import type { AuthSessionId, ClientSurface } from "@t3tools/contracts";

import type { AuthSessionRecord } from "../persistence/AuthSessions.ts";

export const SESSION_CACHE_TTL_MS = 60_000;
export const SESSION_CACHE_NEGATIVE_TTL_MS = 10_000;
export const SESSION_CACHE_MAX_ENTRIES = 10_000;

interface Entry {
  /** `null` records that no row exists for the id. */
  readonly row: AuthSessionRecord | null;
  readonly cachedAtMs: number;
}

export interface VerifiedSessionCache {
  /**
   * The cached row, `null` for a cached "no such session", or `undefined` on a
   * miss (absent or past its TTL).
   */
  readonly get: (sessionId: AuthSessionId, nowMs: number) => AuthSessionRecord | null | undefined;
  /** Take before a database read; pass to `fill`. */
  readonly generation: () => number;
  /** Store a row read from the database, unless an invalidation ran since `generation`. */
  readonly fill: (
    sessionId: AuthSessionId,
    row: AuthSessionRecord | null,
    generation: number,
    nowMs: number,
  ) => void;
  /** Apply a committed write to a cached row. A missing or negative entry stays as it is. */
  readonly patch: (
    sessionId: AuthSessionId,
    update: (row: AuthSessionRecord) => AuthSessionRecord,
  ) => void;
  /** Drop the entry (positive or negative) after a committed write. */
  readonly invalidate: (sessionIds: Iterable<AuthSessionId>) => void;
  readonly size: () => number;
}

const setBounded = <K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number) => {
  // Re-insert so Map order stays oldest-first, then evict from the front.
  map.delete(key);
  while (map.size >= maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  map.set(key, value);
};

export const makeVerifiedSessionCache = (options?: {
  readonly ttlMs?: number;
  readonly negativeTtlMs?: number;
  readonly maxEntries?: number;
}): VerifiedSessionCache => {
  const ttlMs = options?.ttlMs ?? SESSION_CACHE_TTL_MS;
  const negativeTtlMs = options?.negativeTtlMs ?? SESSION_CACHE_NEGATIVE_TTL_MS;
  const maxEntries = options?.maxEntries ?? SESSION_CACHE_MAX_ENTRIES;
  const entries = new Map<AuthSessionId, Entry>();
  let generation = 0;

  return {
    get: (sessionId, nowMs) => {
      const entry = entries.get(sessionId);
      if (entry === undefined) return undefined;
      const age = nowMs - entry.cachedAtMs;
      if (age < 0 || age >= (entry.row === null ? negativeTtlMs : ttlMs)) {
        entries.delete(sessionId);
        return undefined;
      }
      return entry.row;
    },
    generation: () => generation,
    fill: (sessionId, row, readGeneration, nowMs) => {
      if (readGeneration !== generation) return;
      setBounded(entries, sessionId, { row, cachedAtMs: nowMs }, maxEntries);
    },
    patch: (sessionId, update) => {
      generation += 1;
      const entry = entries.get(sessionId);
      if (entry === undefined || entry.row === null) return;
      entries.set(sessionId, { row: update(entry.row), cachedAtMs: entry.cachedAtMs });
    },
    invalidate: (sessionIds) => {
      generation += 1;
      for (const sessionId of sessionIds) entries.delete(sessionId);
    },
    size: () => entries.size,
  };
};

export interface RecordedClientConnection {
  readonly surface: ClientSurface | null;
  readonly appVersion: string | null;
}

/**
 * The last surface/app version this process wrote for each session, so a
 * reconnect that reports the same values skips the UPDATE. `null` means "not
 * written by this process", which matches the write's COALESCE semantics.
 */
export interface ClientConnectionMemo {
  /** The merged values to write, or `undefined` when nothing would change. */
  readonly changes: (
    sessionId: AuthSessionId,
    client: {
      readonly surface?: ClientSurface | undefined;
      readonly appVersion?: string | undefined;
    },
  ) => RecordedClientConnection | undefined;
  readonly remember: (sessionId: AuthSessionId, recorded: RecordedClientConnection) => void;
  readonly forget: (sessionIds: Iterable<AuthSessionId>) => void;
}

export const makeClientConnectionMemo = (options?: {
  readonly maxEntries?: number;
}): ClientConnectionMemo => {
  const maxEntries = options?.maxEntries ?? SESSION_CACHE_MAX_ENTRIES;
  const recorded = new Map<AuthSessionId, RecordedClientConnection>();
  return {
    changes: (sessionId, client) => {
      if (client.surface === undefined && client.appVersion === undefined) return undefined;
      const previous = recorded.get(sessionId);
      const next: RecordedClientConnection = {
        surface: client.surface ?? previous?.surface ?? null,
        appVersion: client.appVersion ?? previous?.appVersion ?? null,
      };
      if (
        previous !== undefined &&
        previous.surface === next.surface &&
        previous.appVersion === next.appVersion
      ) {
        return undefined;
      }
      return next;
    },
    remember: (sessionId, value) => setBounded(recorded, sessionId, value, maxEntries),
    forget: (sessionIds) => {
      for (const sessionId of sessionIds) recorded.delete(sessionId);
    },
  };
};
