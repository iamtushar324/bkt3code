import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import * as ThreadSourceControlActionLock from "./ThreadSourceControlActionLock.ts";

describe("ThreadSourceControlActionLock", () => {
  it.effect("rejects a non-blocking owner switch while another action owns the thread", () =>
    Effect.gen(function* () {
      const lock = yield* ThreadSourceControlActionLock.make;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const threadId = ThreadId.make("thread-alice");

      const active = yield* lock
        .runExclusive(
          threadId,
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      const competing = yield* lock.tryRunExclusive(threadId, Effect.succeed("switched"));
      assert.isTrue(Option.isNone(competing));

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(active);
      const afterRelease = yield* lock.tryRunExclusive(threadId, Effect.succeed("switched"));
      assert.deepStrictEqual(afterRelease, Option.some("switched"));
    }),
  );
});
