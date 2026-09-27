import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository expbkt3 hot paths", (it) => {
  it.effect("appends streaming deltas atomically without losing message metadata", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-streaming-delta-hot-path");
      const messageId = MessageId.make("message-streaming-delta-hot-path");
      const attachments = [
        {
          type: "image" as const,
          id: "streaming-delta-attachment",
          name: "streaming.png",
          mimeType: "image/png",
          sizeBytes: 8,
        },
      ];

      yield* repository.appendTextDelta({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        delta: "Hello",
        attachments,
        isStreaming: true,
        sentByUserId: null,
        createdAt: "2026-08-03T16:35:00.000Z",
        updatedAt: "2026-08-03T16:35:01.000Z",
      });
      yield* repository.appendTextDelta({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        delta: " world",
        isStreaming: true,
        sentByUserId: null,
        createdAt: "2026-08-03T16:35:02.000Z",
        updatedAt: "2026-08-03T16:35:03.000Z",
      });

      const message = yield* repository.getByMessageId({ messageId });
      assert.isTrue(Option.isSome(message));
      const projectedMessage = Option.getOrThrow(message);
      assert.equal(projectedMessage.text, "Hello world");
      assert.equal(projectedMessage.createdAt, "2026-08-03T16:35:00.000Z");
      assert.equal(projectedMessage.updatedAt, "2026-08-03T16:35:03.000Z");
      assert.deepEqual(projectedMessage.attachments, attachments);
      assert.isTrue(projectedMessage.isStreaming);
    }),
  );
});
