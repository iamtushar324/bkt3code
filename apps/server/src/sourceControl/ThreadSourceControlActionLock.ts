import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { ThreadId } from "@t3tools/contracts";

export class ThreadSourceControlActionLock extends Context.Service<
  ThreadSourceControlActionLock,
  {
    readonly runExclusive: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E, R>;
    readonly tryRunExclusive: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Option.Option<A>, E, R>;
  }
>()("t3/sourceControl/ThreadSourceControlActionLock") {}

export const make = Effect.gen(function* () {
  const locks = yield* SynchronizedRef.make(new Map<ThreadId, Semaphore.Semaphore>());

  const getLock = (threadId: ThreadId) =>
    SynchronizedRef.modifyEffect(locks, (current) => {
      const existing = current.get(threadId);
      if (existing !== undefined) {
        return Effect.succeed([existing, current] as const);
      }
      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(threadId, semaphore);
          return [semaphore, next] as const;
        }),
      );
    });

  const runExclusive: ThreadSourceControlActionLock["Service"]["runExclusive"] = (
    threadId,
    effect,
  ) => Effect.flatMap(getLock(threadId), (lock) => lock.withPermit(effect));

  const tryRunExclusive: ThreadSourceControlActionLock["Service"]["tryRunExclusive"] = (
    threadId,
    effect,
  ) => Effect.flatMap(getLock(threadId), (lock) => lock.withPermitsIfAvailable(1)(effect));

  return ThreadSourceControlActionLock.of({ runExclusive, tryRunExclusive });
});

export const layer = Layer.effect(ThreadSourceControlActionLock, make);
