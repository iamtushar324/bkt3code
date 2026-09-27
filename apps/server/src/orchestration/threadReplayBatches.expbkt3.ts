/**
 * T3-CUSTOM(expbkt3): send a thread's catch-up replay in batches.
 *
 * The RPC server writes each stream chunk as one WebSocket frame and waits
 * for the client's ack before writing the next. The replay pipeline taps every
 * event (to notice a delete or archive), and an effectful tap re-emits one
 * event per chunk, so a client that missed 500 events paid 500 network round
 * trips before its thread was current. Re-chunking restores batched frames.
 * The replay is a bounded read that is already in memory page by page, so
 * filling a batch adds no latency.
 */
import * as Stream from "effect/Stream";

export const THREAD_REPLAY_BATCH_SIZE = 128;

export const batchThreadReplay = <A, E, R>(
  replay: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> => Stream.rechunk(replay, THREAD_REPLAY_BATCH_SIZE);
