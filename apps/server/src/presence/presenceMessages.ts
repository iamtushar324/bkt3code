/**
 * T3-CUSTOM(expbkt3): the one projection read presence needs — when each
 * person last wrote in a thread.
 *
 * A full thread-detail snapshot would hydrate every message of the thread on
 * the server's single sqlite loop; this is one indexed aggregate over
 * `projection_thread_messages(thread_id, created_at)`, bounded to the
 * senders a thread can realistically have.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

const MAX_SENDERS = 50;

export interface LatestUserMessage {
  readonly userId: string;
  /** ISO timestamp of the sender's newest user message in the thread. */
  readonly createdAt: string;
}

export class PresenceMessageReadError extends Schema.TaggedError<PresenceMessageReadError>()(
  "PresenceMessageReadError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {}

export class PresenceMessageQuery extends Context.Service<
  PresenceMessageQuery,
  {
    readonly latestUserMessageBySender: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<LatestUserMessage>, PresenceMessageReadError>;
  }
>()("t3/presence/presenceMessages/PresenceMessageQuery") {}

const Row = Schema.Struct({ userId: Schema.String, createdAt: Schema.String });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const query = SqlSchema.findAll({
    Request: ThreadId,
    Result: Row,
    execute: (threadId) => sql`
      SELECT sent_by_user_id AS "userId", MAX(created_at) AS "createdAt"
      FROM (
        SELECT sent_by_user_id, created_at
        FROM projection_thread_messages
        WHERE thread_id = ${threadId} AND role = 'user' AND sent_by_user_id IS NOT NULL
        UNION ALL
        SELECT json_extract(payload_json, '$.sentByUserId') AS sent_by_user_id, created_at
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND role = 'user' AND json_extract(payload_json, '$.sentByUserId') IS NOT NULL
      )
      GROUP BY sent_by_user_id
      ORDER BY "createdAt" DESC
      LIMIT ${MAX_SENDERS}
    `,
  });
  return PresenceMessageQuery.of({
    latestUserMessageBySender: (threadId) =>
      query(threadId).pipe(
        Effect.mapError((cause) => new PresenceMessageReadError({ threadId, cause })),
        Effect.withSpan("presence.latestUserMessageBySender"),
      ),
  });
});

export const layer = Layer.effect(PresenceMessageQuery, make);
