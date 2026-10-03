import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { LiveStreamBufferError } from "./LiveStreamBudget.ts";

const isLiveStreamBufferError = Schema.is(LiveStreamBufferError);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);

function isLiveBufferOverflow(error: unknown): boolean {
  return (
    isLiveStreamBufferError(error) ||
    (isPersistenceSqlError(error) && isLiveBufferOverflow(error.cause))
  );
}

/** Internal listeners resume the durable tail; transport subscribers keep their bounded failure. */
export const forkCompatibilityEvents = <A extends { readonly sequence: number }, B, E, R>(input: {
  readonly latestSequence: Effect.Effect<number, E, R>;
  readonly open: (afterSequence: number) => Stream.Stream<A, E, R>;
  readonly replay: (afterSequence: number, throughSequence: number) => Stream.Stream<A, E, R>;
  readonly translate: (event: A) => Effect.Effect<ReadonlyArray<B>, E, R>;
}): Stream.Stream<B, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Allocate inside the stream so every listener starts and resumes independently.
      let afterSequence = yield* input.latestSequence;
      const deliver = (source: Stream.Stream<A, E, R>): Stream.Stream<B, E, R> =>
        source.pipe(
          Stream.rechunk(1),
          Stream.flatMap((event) =>
            Stream.concat(
              Stream.fromEffect(input.translate(event)).pipe(
                Stream.flatMap(Stream.fromIterable),
                Stream.rechunk(1),
              ),
              // The next pull acknowledges the entire translated batch. Advance even
              // when an application event has no legacy counterpart.
              Stream.fromEffectDrain(
                Effect.sync(() => {
                  afterSequence = event.sequence;
                }),
              ),
            ),
          ),
        );
      const resume = (): Stream.Stream<A, E, R> =>
        Stream.suspend(() => input.open(afterSequence)).pipe(
          Stream.catch((error) =>
            isLiveBufferOverflow(error)
              ? Stream.concat(
                  Stream.fromEffectDrain(
                    Effect.logWarning("Fork compatibility event stream resumes after overflow", {
                      afterSequence,
                    }),
                  ),
                  Stream.concat(
                    // SQL replay has a finite head and bounded pages. Unlike the live
                    // transport budget, it can deliver one event larger than 8 MiB.
                    Stream.fromEffect(input.latestSequence).pipe(
                      Stream.flatMap((throughSequence) =>
                        input.replay(afterSequence, throughSequence),
                      ),
                    ),
                    Stream.suspend(resume),
                  ),
                )
              : Stream.fail(error),
          ),
        );
      // Only the raw live source recovers. Translation and SQL replay failures
      // propagate, even if one happens to wrap the same native error type.
      return deliver(resume());
    }),
  );
