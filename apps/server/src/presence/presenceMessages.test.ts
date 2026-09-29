/**
 * T3-CUSTOM(expbkt3): one aggregate read per report — the newest user message
 * per sender in a thread, and nothing from other threads or roles.
 */
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as PresenceMessages from "./presenceMessages.ts";

const layer = PresenceMessages.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const threadId = ThreadId.make("thread-here");

it.effect("returns the newest user message per sender for the thread only", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = [
      ["m1", "thread-here", "user", "user-a", "2026-09-29T11:00:00.000Z"],
      ["m2", "thread-here", "assistant", null, "2026-09-29T11:01:00.000Z"],
      ["m3", "thread-here", "user", "user-a", "2026-09-29T11:30:00.000Z"],
      ["m4", "thread-here", "user", "user-b", "2026-09-29T11:20:00.000Z"],
      ["m5", "thread-here", "user", null, "2026-09-29T11:59:00.000Z"],
      ["m6", "thread-other", "user", "user-c", "2026-09-29T11:58:00.000Z"],
    ] as const;
    for (const [id, thread, role, sender, createdAt] of rows) {
      yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, turn_id, role, text, is_streaming, sent_by_user_id, created_at, updated_at)
        VALUES (${id}, ${thread}, NULL, ${role}, 'x', 0, ${sender}, ${createdAt}, ${createdAt})
      `;
    }
    const query = yield* PresenceMessages.PresenceMessageQuery;
    expect(yield* query.latestUserMessageBySender(threadId)).toEqual([
      { userId: "user-a", createdAt: "2026-09-29T11:30:00.000Z" },
      { userId: "user-b", createdAt: "2026-09-29T11:20:00.000Z" },
    ]);
    expect(yield* query.latestUserMessageBySender(ThreadId.make("thread-empty"))).toEqual([]);
  }).pipe(Effect.provide(layer)),
);
