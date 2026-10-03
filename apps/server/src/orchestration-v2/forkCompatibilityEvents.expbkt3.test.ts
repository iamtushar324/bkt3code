import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { LiveStreamBufferError, replayAndBufferLiveEvents } from "./LiveStreamBudget.ts";
import { forkCompatibilityEvents } from "./forkCompatibilityEvents.expbkt3.ts";

type Event = { readonly sequence: number };

describe("fork compatibility event recovery", () => {
  it.effect(
    "resumes after actual buffer overflow without losing empty or multi-event translations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<Event>();
          const subscribed = yield* Deferred.make<PubSub.Subscription<Event>>();
          const resumed = yield* Deferred.make<void>();
          const consumerPaused = yield* Deferred.make<void>();
          const releaseConsumer = yield* Deferred.make<void>();
          const durable: Event[] = [];
          const cursors: number[] = [];
          const translated: number[] = [];
          const received: string[] = [];
          const live = forkCompatibilityEvents({
            latestSequence: Effect.sync(() => durable.at(-1)?.sequence ?? 0),
            replay: (afterSequence, throughSequence) =>
              Stream.fromIterable(
                durable.filter(
                  (event) => event.sequence > afterSequence && event.sequence <= throughSequence,
                ),
              ),
            open: (afterSequence) => {
              cursors.push(afterSequence);
              return replayAndBufferLiveEvents(
                {
                  subscribe: PubSub.subscribe(events).pipe(
                    Effect.tap((subscription) =>
                      Effect.gen(function* () {
                        yield* Deferred.succeed(subscribed, subscription);
                        if (afterSequence === 4) yield* Deferred.succeed(resumed, undefined);
                      }),
                    ),
                  ),
                  latestSequence: Effect.sync(() => durable.at(-1)?.sequence ?? 0),
                  afterSequence,
                  replay: (throughSequence) =>
                    Stream.fromIterable(
                      durable.filter(
                        (event) =>
                          event.sequence > afterSequence && event.sequence <= throughSequence,
                      ),
                    ),
                },
                { maxItems: 2 },
              ).pipe(Stream.mapError(toPersistenceSqlError("application events:buffer")));
            },
            translate: (event) =>
              Effect.sync(() => {
                translated.push(event.sequence);
                return event.sequence === 1
                  ? ["one:first", "one:second"]
                  : event.sequence === 2
                    ? []
                    : event.sequence === 3
                      ? ["three:first", "three:second"]
                      : [String(event.sequence)];
              }),
          });
          const consumer = yield* live.pipe(
            Stream.take(6),
            Stream.runForEach((value) =>
              Effect.gen(function* () {
                received.push(value);
                if (value === "one:first") {
                  yield* Deferred.succeed(consumerPaused, undefined);
                  yield* Deferred.await(releaseConsumer);
                }
              }),
            ),
            Effect.forkScoped,
          );
          const subscription = yield* Deferred.await(subscribed);
          durable.push({ sequence: 1 });
          yield* PubSub.publish(events, durable[0]!);
          yield* Deferred.await(consumerPaused);
          const pending = [{ sequence: 2 }, { sequence: 3 }, { sequence: 4 }];
          durable.push(...pending);
          yield* PubSub.publishAll(events, pending);
          // The original subscription closes on overflow even while its consumer is paused.
          yield* subscription.shutdownHook.await;
          expect(received).toEqual(["one:first"]);
          yield* Deferred.succeed(releaseConsumer, undefined);
          yield* Deferred.await(resumed);
          durable.push({ sequence: 5 });
          yield* PubSub.publish(events, durable.at(-1)!);
          yield* Fiber.join(consumer);
          expect(cursors).toEqual([0, 4]);
          expect(translated).toEqual([1, 2, 3, 4, 5]);
          expect(received).toEqual([
            "one:first",
            "one:second",
            "three:first",
            "three:second",
            "4",
            "5",
          ]);
        }),
      ),
  );

  it.effect("keeps each listener cursor independent while a slower listener recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<Event>();
        const slowSubscribed = yield* Deferred.make<PubSub.Subscription<Event>>();
        const fastSubscribed = yield* Deferred.make<void>();
        const slowResumed = yield* Deferred.make<void>();
        const slowPaused = yield* Deferred.make<void>();
        const releaseSlow = yield* Deferred.make<void>();
        const fastReceived = yield* Effect.forEach([1, 2, 3, 4], () => Deferred.make<void>());
        const durable: Event[] = [];
        const cursors: number[] = [];
        const slowValues: number[] = [];
        const fastValues: number[] = [];
        let subscriptions = 0;
        const live = forkCompatibilityEvents({
          latestSequence: Effect.sync(() => durable.at(-1)?.sequence ?? 0),
          replay: (afterSequence, throughSequence) =>
            Stream.fromIterable(
              durable.filter(
                (event) => event.sequence > afterSequence && event.sequence <= throughSequence,
              ),
            ),
          open: (afterSequence) => {
            cursors.push(afterSequence);
            return replayAndBufferLiveEvents(
              {
                subscribe: PubSub.subscribe(events).pipe(
                  Effect.tap((subscription) => {
                    subscriptions++;
                    return afterSequence === 3
                      ? Deferred.succeed(slowResumed, undefined)
                      : subscriptions === 1
                        ? Deferred.succeed(slowSubscribed, subscription)
                        : Deferred.succeed(fastSubscribed, undefined);
                  }),
                ),
                latestSequence: Effect.sync(() => durable.at(-1)?.sequence ?? 0),
                afterSequence,
                replay: (throughSequence) =>
                  Stream.fromIterable(
                    durable.filter(
                      (event) =>
                        event.sequence > afterSequence && event.sequence <= throughSequence,
                    ),
                  ),
              },
              { maxItems: 2 },
            ).pipe(Stream.mapError(toPersistenceSqlError("application events:buffer")));
          },
          translate: (event) => Effect.succeed([event.sequence]),
        });
        const slow = yield* live.pipe(
          Stream.take(4),
          Stream.runForEach((value) =>
            Effect.gen(function* () {
              slowValues.push(value);
              if (value === 1) {
                yield* Deferred.succeed(slowPaused, undefined);
                yield* Deferred.await(releaseSlow);
              }
            }),
          ),
          Effect.forkScoped,
        );
        const slowSubscription = yield* Deferred.await(slowSubscribed);
        const fast = yield* live.pipe(
          Stream.take(4),
          Stream.runForEach((value) =>
            Effect.gen(function* () {
              fastValues.push(value);
              yield* Deferred.succeed(fastReceived[value - 1]!, undefined);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(fastSubscribed);
        for (const sequence of [1, 2, 3]) {
          const event = { sequence };
          durable.push(event);
          yield* PubSub.publish(events, event);
          yield* Deferred.await(fastReceived[sequence - 1]!);
          if (sequence === 1) yield* Deferred.await(slowPaused);
        }
        yield* slowSubscription.shutdownHook.await;
        yield* Deferred.succeed(releaseSlow, undefined);
        yield* Deferred.await(slowResumed);
        durable.push({ sequence: 4 });
        yield* PubSub.publish(events, durable.at(-1)!);
        yield* Fiber.join(slow);
        yield* Fiber.join(fast);
        expect(cursors).toEqual([0, 0, 3]);
        expect(slowValues).toEqual([1, 2, 3, 4]);
        expect(fastValues).toEqual([1, 2, 3, 4]);
      }),
    ),
  );

  it.effect("acknowledges untranslated application events before the next recovery", () =>
    Effect.gen(function* () {
      const cursors: number[] = [];
      const replayCursors: number[] = [];
      let headReads = 0;
      const overflow = new LiveStreamBufferError({ message: "forced overflow" });
      const values = yield* forkCompatibilityEvents({
        latestSequence: Effect.sync(() => (headReads++ === 0 ? 0 : 3)),
        replay: (afterSequence) => {
          replayCursors.push(afterSequence);
          return Stream.succeed({ sequence: 3 });
        },
        open: (afterSequence) => {
          cursors.push(afterSequence);
          return afterSequence === 0
            ? Stream.fromIterable([{ sequence: 1 }, { sequence: 2 }]).pipe(
                Stream.concat(
                  Stream.fail(toPersistenceSqlError("application events:buffer")(overflow)),
                ),
              )
            : Stream.empty;
        },
        translate: (event) => Effect.succeed(event.sequence === 2 ? [] : [event.sequence]),
      }).pipe(Stream.runCollect);
      expect(cursors).toEqual([0, 3]);
      expect(replayCursors).toEqual([2]);
      expect(values).toEqual([1, 3]);
    }),
  );

  it.effect("replays an event larger than the native byte cap once and resumes the live tail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        type LargeEvent = Event & { readonly payload: string };
        const events = yield* PubSub.unbounded<LargeEvent>();
        const initialSubscription = yield* Deferred.make<PubSub.Subscription<LargeEvent>>();
        const resumed = yield* Deferred.make<void>();
        const durable: LargeEvent[] = [];
        const cursors: number[] = [];
        const replayRanges: Array<readonly [number, number]> = [];
        const translated: number[] = [];
        const live = forkCompatibilityEvents({
          latestSequence: Effect.sync(() => durable.at(-1)?.sequence ?? 0),
          replay: (afterSequence, throughSequence) => {
            replayRanges.push([afterSequence, throughSequence]);
            return Stream.fromIterable(
              durable.filter(
                (event) => event.sequence > afterSequence && event.sequence <= throughSequence,
              ),
            );
          },
          open: (afterSequence) => {
            cursors.push(afterSequence);
            // Use the production 8 MiB cap, not a smaller test limit.
            return replayAndBufferLiveEvents({
              subscribe: PubSub.subscribe(events).pipe(
                Effect.tap((subscription) =>
                  afterSequence === 0
                    ? Deferred.succeed(initialSubscription, subscription)
                    : Deferred.succeed(resumed, undefined),
                ),
              ),
              latestSequence: Effect.sync(() => durable.at(-1)?.sequence ?? 0),
              afterSequence,
              replay: (throughSequence) =>
                Stream.fromIterable(
                  durable.filter(
                    (event) => event.sequence > afterSequence && event.sequence <= throughSequence,
                  ),
                ),
            }).pipe(Stream.mapError(toPersistenceSqlError("application events:buffer")));
          },
          translate: (event) =>
            Effect.sync(() => {
              translated.push(event.sequence);
              return [event.sequence];
            }),
        });
        const consumer = yield* live.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped);
        const subscription = yield* Deferred.await(initialSubscription);
        const oversized = { sequence: 1, payload: "x".repeat(8 * 1024 * 1024 + 1) };
        durable.push(oversized);
        yield* PubSub.publish(events, oversized);
        yield* subscription.shutdownHook.await;
        yield* Deferred.await(resumed);
        const normal = { sequence: 2, payload: "after recovery" };
        durable.push(normal);
        yield* PubSub.publish(events, normal);
        expect(yield* Fiber.join(consumer)).toEqual([1, 2]);
        expect(cursors).toEqual([0, 1]);
        expect(replayRanges).toEqual([[0, 1]]);
        expect(translated).toEqual([1, 2]);
      }),
    ),
  );

  it.effect.each(["ordinary", "wrapped-overflow"] as const)(
    "does not retry a %s translation failure",
    (kind) =>
      Effect.gen(function* () {
        const failure = new PersistenceSqlError({
          operation: "compatibility translation",
          ...(kind === "wrapped-overflow"
            ? { cause: new LiveStreamBufferError({ message: "translation failure" }) }
            : {}),
        });
        let opens = 0;
        const result = yield* forkCompatibilityEvents({
          latestSequence: Effect.succeed(0),
          replay: () => Stream.empty,
          open: () => {
            opens++;
            return Stream.succeed({ sequence: 1 });
          },
          translate: () => Effect.fail(failure),
        }).pipe(Stream.runDrain, Effect.result);
        expect(opens).toBe(1);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBe(failure);
      }),
  );
});
