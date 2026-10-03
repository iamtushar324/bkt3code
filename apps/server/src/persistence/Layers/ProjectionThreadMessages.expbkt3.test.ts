import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ProjectionStoreV2,
  layer as projectionLayer,
} from "../../orchestration-v2/ProjectionStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it.layer(projectionLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "native message persistence",
  (it) => {
    it.effect("keeps sender and attachment metadata when provider text advances", () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionStoreV2;
        const threadId = ThreadId.make("thread:message-metadata");
        const messageId = MessageId.make("message:metadata");
        const now = DateTime.makeUnsafe("2026-08-03T16:35:00Z");
        const instanceId = ProviderInstanceId.make("codex");
        yield* repository.apply({
          id: EventId.make("event:thread-message"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            id: threadId,
            projectId: ProjectId.make("project:metadata"),
            title: "Metadata",
            modelSelection: { instanceId, model: "gpt-5.4" },
            providerInstanceId: instanceId,
            createdBy: "user",
            creationSource: "web",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const attachments = [
          {
            type: "image" as const,
            id: "attachment:metadata",
            name: "image.png",
            mimeType: "image/png",
            sizeBytes: 8,
          },
        ];
        const message = {
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant" as const,
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          text: "Hello",
          attachments,
          streaming: true,
          sentByUserId: UserId.make("user:sender"),
          createdAt: DateTime.makeUnsafe("2026-08-03T16:35:00Z"),
          updatedAt: DateTime.makeUnsafe("2026-08-03T16:35:01Z"),
        };
        yield* repository.apply({
          id: EventId.make("event:message-first"),
          type: "message.updated",
          threadId,
          occurredAt: message.updatedAt,
          payload: message,
        });
        yield* repository.apply({
          id: EventId.make("event:message-next"),
          type: "message.updated",
          threadId,
          occurredAt: DateTime.makeUnsafe("2026-08-03T16:35:03Z"),
          payload: {
            ...message,
            text: "Hello world",
            updatedAt: DateTime.makeUnsafe("2026-08-03T16:35:03Z"),
          },
        });
        const projection = yield* repository.getThreadRecords(threadId, ["messages"]);
        const projected = projection.messages[0];
        assert.equal(projected?.text, "Hello world");
        assert.equal(projected?.sentByUserId, "user:sender");
        assert.deepStrictEqual(projected?.attachments, attachments);
        assert.equal(
          projected === undefined ? null : DateTime.formatIso(projected.createdAt),
          "2026-08-03T16:35:00.000Z",
        );
      }),
    );
  },
);
