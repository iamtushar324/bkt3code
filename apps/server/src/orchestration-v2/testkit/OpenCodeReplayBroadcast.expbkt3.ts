import * as Schema from "effect/Schema";
import type { OpenCodeReplayController } from "../Adapters/OpenCodeAdapterV2.testkit.ts";

interface Broadcast {
  readonly subscribers: Set<ReadableStreamDefaultController<Uint8Array>>;
  running: boolean;
}
const broadcasts = new WeakMap<OpenCodeReplayController, Broadcast>();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A real OpenCode server sends each event to every SSE connection, including independent app runtimes. */
export function openCodeReplayEventStream(
  controller: OpenCodeReplayController,
  beforeEmit?: (label: string | undefined) => Promise<void>,
): ReadableStream<Uint8Array> {
  let broadcast = broadcasts.get(controller);
  if (broadcast === undefined) {
    broadcast = { subscribers: new Set(), running: false };
    broadcasts.set(controller, broadcast);
  }
  const current = broadcast;
  let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pump = async () => {
    const encoder = new TextEncoder();
    try {
      for await (const event of controller.events(undefined, beforeEmit)) {
        const data = encoder.encode(`data: ${encodeJson(event)}\n\n`);
        for (const stream of current.subscribers) stream.enqueue(data);
      }
      for (const stream of current.subscribers) stream.close();
    } catch (cause) {
      for (const stream of current.subscribers) stream.error(cause);
    } finally {
      current.subscribers.clear();
      current.running = false;
    }
  };
  return new ReadableStream({
    start(stream) {
      subscriber = stream;
      current.subscribers.add(stream);
      if (!current.running) {
        current.running = true;
        void pump();
      }
    },
    cancel() {
      if (subscriber !== undefined) current.subscribers.delete(subscriber);
    },
  });
}
