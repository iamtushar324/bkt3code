import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import { makeStaleWhileRevalidate } from "./connectDiscoveryCache.expbkt3.ts";

/** A discovery that takes `scanTime` and returns how many scans have started. */
const countingDiscovery = (scanTime: string) => {
  let scans = 0;
  const discover = Effect.sync(() => ++scans).pipe(Effect.delay(scanTime));
  return { discover, scans: () => scans };
};

describe("makeStaleWhileRevalidate", () => {
  it.effect("serves later callers from the first scan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { discover, scans } = countingDiscovery("1 second");
        const get = yield* makeStaleWhileRevalidate(discover, "1 minute");

        const first = yield* Effect.forkChild(get, { startImmediately: true });
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Fiber.join(first), 1);
        assert.strictEqual(yield* get, 1);
        assert.strictEqual(scans(), 1);
      }),
    ),
  );

  it.effect("keeps scanning after a caller times out, so the next caller gets the result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { discover, scans } = countingDiscovery("8 seconds");
        const get = yield* makeStaleWhileRevalidate(discover, "1 minute");

        const impatient = yield* Effect.forkChild(get.pipe(Effect.timeoutOption("5 seconds")), {
          startImmediately: true,
        });
        yield* TestClock.adjust("5 seconds");
        assert.isTrue(Option.isNone(yield* Fiber.join(impatient)));

        yield* TestClock.adjust("3 seconds");
        // Answered from the finished scan without waiting or scanning again.
        assert.strictEqual(yield* get, 1);
        assert.strictEqual(scans(), 1);
      }),
    ),
  );

  it.effect("answers a stale value at once and refreshes it in the background", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { discover, scans } = countingDiscovery("1 second");
        const get = yield* makeStaleWhileRevalidate(discover, "1 minute");

        const first = yield* Effect.forkChild(get, { startImmediately: true });
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* Fiber.join(first), 1);

        yield* TestClock.adjust("1 minute");
        assert.strictEqual(yield* get, 1);
        // A second stale read while the refresh runs does not start another.
        assert.strictEqual(yield* get, 1);

        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* get, 2);
        assert.strictEqual(scans(), 2);
      }),
    ),
  );

  it.effect("shares one scan between callers that arrive before the first result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { discover, scans } = countingDiscovery("2 seconds");
        const get = yield* makeStaleWhileRevalidate(discover, "1 minute");

        const callers = yield* Effect.forkChild(
          Effect.all([get, get, get], { concurrency: "unbounded" }),
          { startImmediately: true },
        );
        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(yield* Fiber.join(callers), [1, 1, 1]);
        assert.strictEqual(scans(), 1);
      }),
    ),
  );
});
