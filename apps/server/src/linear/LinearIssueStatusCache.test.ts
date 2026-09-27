import type { LinearIssueStatusSummary } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";

import {
  DEFAULT_ERROR_TTL_MS,
  DEFAULT_STATUS_TTL_MS,
  makeLinearIssueStatusCache,
} from "./LinearIssueStatusCache.ts";

const ok = (identifier: string, status = "In Progress"): LinearIssueStatusSummary => ({
  identifier,
  url: `https://linear.app/beknown/issue/${identifier}`,
  status,
  statusType: "started",
  updatedAt: "2026-09-16T00:00:00.000Z",
  error: null,
});

const failed = (identifier: string): LinearIssueStatusSummary => ({
  identifier,
  url: null,
  status: null,
  statusType: null,
  updatedAt: null,
  error: "Linear status is temporarily unavailable.",
});

describe("LinearIssueStatusCache", () => {
  it.effect("reads upstream once and serves the rest of the window from cache", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.update(calls, (all) => [...all, missing]).pipe(
          Effect.as(missing.map((identifier) => ok(identifier))),
        );

      expect((yield* cache.resolve(["TEC-1"], fetch)).map((s) => s.status)).toEqual([
        "In Progress",
      ]);
      expect((yield* cache.resolve(["TEC-1"], fetch)).map((s) => s.status)).toEqual([
        "In Progress",
      ]);

      // Two viewers, one upstream read.
      expect(yield* Ref.get(calls)).toEqual([["TEC-1"]]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("asks only for the identifiers it does not already hold", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.update(calls, (all) => [...all, missing]).pipe(
          Effect.as(missing.map((identifier) => ok(identifier))),
        );

      yield* cache.resolve(["TEC-1", "TEC-2"], fetch);
      const second = yield* cache.resolve(["TEC-2", "TEC-3"], fetch);

      expect(yield* Ref.get(calls)).toEqual([["TEC-1", "TEC-2"], ["TEC-3"]]);
      // The answer still covers everything asked for, in the order asked.
      expect(second.map((s) => s.identifier)).toEqual(["TEC-2", "TEC-3"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("collapses concurrent callers onto one in-flight read", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const calls = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(missing.map((identifier) => ok(identifier))),
        );

      // Both fibers want TEC-1 while the first read is still outstanding.
      const first = yield* Effect.forkChild(cache.resolve(["TEC-1"], fetch), {
        startImmediately: true,
      });
      const second = yield* Effect.forkChild(cache.resolve(["TEC-1"], fetch), {
        startImmediately: true,
      });
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.succeed(gate, undefined);

      expect((yield* Fiber.join(first)).map((s) => s.status)).toEqual(["In Progress"]);
      expect((yield* Fiber.join(second)).map((s) => s.status)).toEqual(["In Progress"]);
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("releases its claim when the caller walks away mid-read", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const calls = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.update(calls, (n) => n + 1).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as(missing.map((identifier) => ok(identifier))),
        );

      // The sidebar refreshes on its own interval and interrupts the request it
      // replaces. The read that request claimed has to survive it, or the
      // identifier stays pinned as in-flight behind a Deferred nobody completes.
      const abandoned = yield* Effect.forkChild(cache.resolve(["TEC-1"], fetch), {
        startImmediately: true,
      });
      yield* TestClock.adjust(Duration.millis(1));
      yield* Fiber.interrupt(abandoned);

      const next = yield* Effect.forkChild(cache.resolve(["TEC-1"], fetch), {
        startImmediately: true,
      });
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.succeed(gate, undefined);

      expect((yield* Fiber.join(next)).map((s) => s.status)).toEqual(["In Progress"]);
      // The abandoned read still counts: it finished and filled the cache.
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("answers from the last known status while it refreshes behind it", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const calls = yield* Ref.make(0);
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.map((n) => missing.map((identifier) => ok(identifier, `state-${n}`))),
        );

      expect((yield* cache.resolve(["TEC-1"], fetch))[0]?.status).toBe("state-1");
      yield* TestClock.adjust(Duration.millis(DEFAULT_STATUS_TTL_MS + 1));
      // Past the TTL the answer is served immediately rather than blocking on a
      // fresh upstream read; that read runs behind it.
      expect((yield* cache.resolve(["TEC-1"], fetch))[0]?.status).toBe("state-1");
      yield* TestClock.adjust(Duration.millis(1));
      expect((yield* cache.resolve(["TEC-1"], fetch))[0]?.status).toBe("state-2");
      expect(yield* Ref.get(calls)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("blocks only until a status it has never seen arrives", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const gate = yield* Deferred.make<void>();
      const fetch = (missing: ReadonlyArray<string>) =>
        Deferred.await(gate).pipe(Effect.as(missing.map((identifier) => ok(identifier))));

      const first = yield* Effect.forkChild(cache.resolve(["TEC-1"], fetch), {
        startImmediately: true,
      });
      yield* TestClock.adjust(Duration.millis(1));
      yield* Deferred.succeed(gate, undefined);
      expect((yield* Fiber.join(first)).map((s) => s.status)).toEqual(["In Progress"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("lets a failure expire faster than a good answer", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const calls = yield* Ref.make(0);
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.map((n) =>
            n === 1 ? missing.map(failed) : missing.map((identifier) => ok(identifier)),
          ),
        );

      expect((yield* cache.resolve(["TEC-1"], fetch))[0]?.error).not.toBeNull();
      yield* TestClock.adjust(Duration.millis(DEFAULT_ERROR_TTL_MS + 1));
      // Well inside the success TTL, so only the shorter error TTL can explain this.
      expect((yield* cache.resolve(["TEC-1"], fetch))[0]?.error).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("answers every identifier even when the upstream read dies", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const resolved = yield* cache.resolve(["TEC-1", "TEC-2"], () =>
        Effect.die(new Error("bifrost exploded")),
      );

      // A hung Deferred here would strand every waiting caller.
      expect(resolved.map((s) => s.identifier)).toEqual(["TEC-1", "TEC-2"]);
      expect(resolved.every((s) => s.error !== null)).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("re-reads an identifier whose read fell over rather than pinning it", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const resolved = yield* cache.resolve(["TEC-1"], () => Effect.interrupt);

      expect(resolved.map((s) => s.identifier)).toEqual(["TEC-1"]);
      expect(resolved[0]?.error).not.toBeNull();

      // The claim the dead read took out has to be gone with it, or the retry
      // queues behind it forever instead of asking again.
      yield* TestClock.adjust(Duration.millis(DEFAULT_ERROR_TTL_MS + 1));
      const retried = yield* cache.resolve(["TEC-1"], (missing) =>
        Effect.succeed(missing.map((identifier) => ok(identifier))),
      );
      expect(retried[0]?.status).toBe("In Progress");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps an identifier the upstream simply omitted from hanging", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache();
      const resolved = yield* cache.resolve(["TEC-1", "TEC-2"], () =>
        Effect.succeed([ok("TEC-1")]),
      );

      expect(resolved[0]?.status).toBe("In Progress");
      expect(resolved[1]?.error).not.toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("evicts by soonest expiry once it is full", () =>
    Effect.gen(function* () {
      const cache = yield* makeLinearIssueStatusCache({ maxEntries: 2 });
      const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
      const fetch = (missing: ReadonlyArray<string>) =>
        Ref.update(calls, (all) => [...all, missing]).pipe(
          Effect.as(missing.map((identifier) => ok(identifier))),
        );

      yield* cache.resolve(["TEC-1", "TEC-2"], fetch);
      yield* TestClock.adjust(Duration.millis(10));
      yield* cache.resolve(["TEC-3"], fetch);
      // TEC-1 and TEC-2 expire soonest, so the newest entry is the survivor.
      yield* cache.resolve(["TEC-3"], fetch);

      expect(yield* Ref.get(calls)).toEqual([["TEC-1", "TEC-2"], ["TEC-3"]]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
