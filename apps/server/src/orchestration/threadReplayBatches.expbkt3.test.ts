import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import { batchThreadReplay, THREAD_REPLAY_BATCH_SIZE } from "./threadReplayBatches.expbkt3.ts";

const PAGE_SIZE = 200;

// Same shape as the thread catch-up in ws.ts: pages read from the event store,
// then an effectful per-event tap and pure filter/map steps.
const tappedReplay = (eventCount: number) =>
  Stream.paginate(0, (cursor) => {
    const page = Array.from(
      { length: Math.min(PAGE_SIZE, eventCount - cursor) },
      (_, index) => cursor + index + 1,
    );
    const next = cursor + page.length;
    return Effect.succeed([page, next < eventCount ? Option.some(next) : Option.none()] as const);
  }).pipe(
    Stream.tap(() => Effect.void),
    Stream.filter((sequence) => sequence > 0),
    Stream.map((sequence) => ({ kind: "event" as const, sequence })),
  );

// Each array handed to runForEachArray is one frame the RPC server writes.
const frameSizes = <A>(stream: Stream.Stream<A>) =>
  Effect.gen(function* () {
    const sizes: Array<number> = [];
    yield* stream.pipe(
      Stream.runForEachArray((items) => Effect.sync(() => sizes.push(items.length))),
    );
    return sizes;
  });

it.effect("an unbatched tapped replay reaches the writer one event per frame", () =>
  Effect.gen(function* () {
    const sizes = yield* frameSizes(tappedReplay(500));
    expect(sizes.length).toBe(500);
  }),
);

it.effect("a batched replay reaches the writer in full batches, in order", () =>
  Effect.gen(function* () {
    const sizes = yield* frameSizes(batchThreadReplay(tappedReplay(500)));
    expect(sizes).toEqual([
      THREAD_REPLAY_BATCH_SIZE,
      THREAD_REPLAY_BATCH_SIZE,
      THREAD_REPLAY_BATCH_SIZE,
      500 - 3 * THREAD_REPLAY_BATCH_SIZE,
    ]);
    const sequences = yield* batchThreadReplay(tappedReplay(500)).pipe(
      Stream.map((item) => item.sequence),
      Stream.runCollect,
    );
    expect(Array.from(sequences)).toEqual(Array.from({ length: 500 }, (_, index) => index + 1));
  }),
);

it.effect("a short replay is flushed as soon as the read ends", () =>
  Effect.gen(function* () {
    expect(yield* frameSizes(batchThreadReplay(tappedReplay(3)))).toEqual([3]);
    expect(yield* frameSizes(batchThreadReplay(tappedReplay(0)))).toEqual([]);
  }),
);
