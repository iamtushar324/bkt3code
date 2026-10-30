import { AuthSessionId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { AuthSessionRecord } from "../persistence/AuthSessions.ts";
import {
  makeClientConnectionMemo,
  makeVerifiedSessionCache,
  SESSION_CACHE_NEGATIVE_TTL_MS,
  SESSION_CACHE_TTL_MS,
} from "./VerifiedSessionCache.expbkt3.ts";

const sessionId = AuthSessionId.make("session-a");
const otherSessionId = AuthSessionId.make("session-b");

const row = (overrides?: Partial<AuthSessionRecord>): AuthSessionRecord => ({
  sessionId,
  userId: null,
  subject: "browser",
  scopes: ["orchestration:read"],
  method: "browser-session-cookie",
  client: {
    label: null,
    ipAddress: null,
    userAgent: null,
    deviceType: "desktop",
    os: null,
    browser: null,
    appVersion: null,
  },
  issuedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(1_000_000),
  lastConnectedAt: null,
  revokedAt: null,
  ...overrides,
});

describe("VerifiedSessionCache", () => {
  it("serves a row until its TTL and an unknown id for the shorter negative TTL", () => {
    const cache = makeVerifiedSessionCache();
    cache.fill(sessionId, row(), cache.generation(), 0);
    cache.fill(otherSessionId, null, cache.generation(), 0);

    expect(cache.get(sessionId, SESSION_CACHE_NEGATIVE_TTL_MS)?.sessionId).toBe(sessionId);
    expect(cache.get(otherSessionId, SESSION_CACHE_NEGATIVE_TTL_MS - 1)).toBeNull();
    expect(cache.get(otherSessionId, SESSION_CACHE_NEGATIVE_TTL_MS)).toBeUndefined();
    expect(cache.get(sessionId, SESSION_CACHE_TTL_MS)).toBeUndefined();
  });

  it("drops a read that raced with an invalidation", () => {
    const cache = makeVerifiedSessionCache();
    const generation = cache.generation();
    // A revoke commits and invalidates while the read is in flight.
    cache.invalidate([sessionId]);
    cache.fill(sessionId, row(), generation, 0);

    expect(cache.get(sessionId, 0)).toBeUndefined();
  });

  it("clears a negative entry when the session is created", () => {
    const cache = makeVerifiedSessionCache();
    cache.fill(sessionId, null, cache.generation(), 0);
    expect(cache.get(sessionId, 1)).toBeNull();

    cache.invalidate([sessionId]);
    expect(cache.get(sessionId, 1)).toBeUndefined();
  });

  it("patches a cached row without touching a negative entry", () => {
    const cache = makeVerifiedSessionCache();
    cache.fill(sessionId, row(), cache.generation(), 0);
    cache.fill(otherSessionId, null, cache.generation(), 0);
    const lastConnectedAt = DateTime.makeUnsafe(500);

    cache.patch(sessionId, (cached) => ({ ...cached, lastConnectedAt }));
    cache.patch(otherSessionId, (cached) => ({ ...cached, lastConnectedAt }));

    expect(cache.get(sessionId, 1)?.lastConnectedAt).toEqual(lastConnectedAt);
    expect(cache.get(otherSessionId, 1)).toBeNull();
  });

  it("evicts the oldest entry once full", () => {
    const cache = makeVerifiedSessionCache({ maxEntries: 2 });
    const third = AuthSessionId.make("session-c");
    cache.fill(sessionId, row(), cache.generation(), 0);
    cache.fill(otherSessionId, row({ sessionId: otherSessionId }), cache.generation(), 1);
    cache.fill(third, row({ sessionId: third }), cache.generation(), 2);

    expect(cache.size()).toBe(2);
    expect(cache.get(sessionId, 3)).toBeUndefined();
    expect(cache.get(third, 3)?.sessionId).toBe(third);
  });
});

describe("ClientConnectionMemo", () => {
  it("reports a change only when the merged surface or app version differs", () => {
    const memo = makeClientConnectionMemo();
    const first = memo.changes(sessionId, { surface: "web", appVersion: "1.0.0" });
    expect(first).toEqual({ surface: "web", appVersion: "1.0.0" });
    memo.remember(sessionId, first!);

    expect(memo.changes(sessionId, { surface: "web", appVersion: "1.0.0" })).toBeUndefined();
    expect(memo.changes(sessionId, { surface: "web" })).toBeUndefined();
    expect(memo.changes(sessionId, {})).toBeUndefined();
    expect(memo.changes(sessionId, { appVersion: "1.1.0" })).toEqual({
      surface: "web",
      appVersion: "1.1.0",
    });

    memo.forget([sessionId]);
    expect(memo.changes(sessionId, { surface: "web", appVersion: "1.0.0" })).toBeDefined();
  });
});
