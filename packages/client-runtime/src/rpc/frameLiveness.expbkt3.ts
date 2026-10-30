import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Socket from "effect/socket/Socket";

/**
 * Wraps the session's socket so every received frame (a pong, a stream item,
 * a reply) stamps `lastFrameAt` with the clock time in milliseconds.
 *
 * The supervisor reads the stamp when a health probe is late: a socket that
 * still delivers frames reaches a busy server, so the connection is slow, not
 * dead, and replacing it would only add load (TEC-1837).
 */
export const layerSocketFrameLiveness = (lastFrameAt: Ref.Ref<number>) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      const socket = yield* Socket.Socket;
      const markFrame = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Ref.set(lastFrameAt, now)),
      );
      return Socket.make({
        reader: Effect.map(socket.reader, (reader) => ({
          pull: Effect.tap(reader.pull, () => markFrame),
          upgrade: reader.upgrade,
        })),
        writer: socket.writer,
      });
    }),
  );

/** True when the session received a frame at or after `sinceMillis`. */
export const receivedFrameSince = (
  lastFrameAt: Effect.Effect<number> | undefined,
  sinceMillis: number,
): Effect.Effect<boolean> =>
  lastFrameAt === undefined
    ? Effect.succeed(false)
    : Effect.map(lastFrameAt, (at) => at >= sinceMillis);
