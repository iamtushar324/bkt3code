import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ChatAttachment, OrchestrationMessageContext } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  // T3-CUSTOM(expbkt3): atomic streaming-delta hot path.
  AppendProjectionThreadMessageDeltaInput,
  AppendStreamingProjectionThreadMessage,
  GetProjectionThreadMessageInput,
  HasProjectionThreadAssistantMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    context: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  }),
);
const ProjectionThreadMessageExistsDbRowSchema = Schema.Struct({ exists: Schema.Number });

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    sentByUserId: row.sentByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.context !== null ? { context: row.context } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextContextJson = row.context !== undefined ? JSON.stringify(row.context) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          context_json,
          is_streaming,
          sent_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextContextJson},
            (
              SELECT context_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.sentByUserId},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          context_json = COALESCE(
            excluded.context_json,
            projection_thread_messages.context_json
          ),
          is_streaming = excluded.is_streaming,
          sent_by_user_id = COALESCE(
            excluded.sent_by_user_id,
            projection_thread_messages.sent_by_user_id
          ),
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const appendStreamingProjectionThreadMessageRow = SqlSchema.void({
    Request: AppendStreamingProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextContextJson = row.context !== undefined ? JSON.stringify(row.context) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          context_json,
          is_streaming,
          -- T3-CUSTOM(expbkt3): preserve sender identity on the upstream streaming API.
          sent_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          ${nextAttachmentsJson},
          ${nextContextJson},
          1,
          ${row.sentByUserId},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = projection_thread_messages.text || excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          context_json = COALESCE(
            excluded.context_json,
            projection_thread_messages.context_json
          ),
          is_streaming = 1,
          sent_by_user_id = COALESCE(excluded.sent_by_user_id, projection_thread_messages.sent_by_user_id),
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          sent_by_user_id AS "sentByUserId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  // T3-CUSTOM(expbkt3): let SQLite append deltas without copying the growing body into Node.
  const appendProjectionThreadMessageDeltaRow = SqlSchema.void({
    Request: AppendProjectionThreadMessageDeltaInput,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextContextJson = row.context !== undefined ? JSON.stringify(row.context) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          context_json,
          is_streaming,
          sent_by_user_id,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.delta},
          ${nextAttachmentsJson},
          ${nextContextJson},
          ${row.isStreaming ? 1 : 0},
          ${row.sentByUserId},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = COALESCE(excluded.turn_id, projection_thread_messages.turn_id),
          role = excluded.role,
          text = projection_thread_messages.text || excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          context_json = COALESCE(
            excluded.context_json,
            projection_thread_messages.context_json
          ),
          is_streaming = excluded.is_streaming,
          sent_by_user_id = COALESCE(
            excluded.sent_by_user_id,
            projection_thread_messages.sent_by_user_id
          ),
          updated_at = excluded.updated_at
      `;
    },
  });

  const hasProjectionThreadAssistantMessageRow = SqlSchema.findOne({
    Request: HasProjectionThreadAssistantMessageInput,
    Result: ProjectionThreadMessageExistsDbRowSchema,
    execute: ({ threadId, turnId, streamingOnly }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM projection_thread_messages
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
            AND role = 'assistant'
            AND (${streamingOnly ? 1 : 0} = 0 OR is_streaming = 1)
          LIMIT 1
        ) AS "exists"
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          sent_by_user_id AS "sentByUserId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getLatestUserMessageAtRow = SqlSchema.findOne({
    Request: ListProjectionThreadMessagesInput,
    Result: Schema.Struct({
      latestUserMessageAt: Schema.NullOr(ProjectionThreadMessage.fields.createdAt),
    }),
    execute: ({ threadId }) => sql`
      SELECT MAX(created_at) AS "latestUserMessageAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND role = 'user'
        AND message_id NOT GLOB 'import:*'
    `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const appendStreaming: ProjectionThreadMessageRepositoryShape["appendStreaming"] = (row) =>
    appendStreamingProjectionThreadMessageRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.appendStreaming:query"),
      ),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  // T3-CUSTOM(expbkt3): atomic streaming-delta hot path.
  const appendTextDelta: ProjectionThreadMessageRepositoryShape["appendTextDelta"] = (input) =>
    appendProjectionThreadMessageDeltaRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.appendTextDelta:query"),
      ),
    );

  const hasAssistantMessageForTurn: ProjectionThreadMessageRepositoryShape["hasAssistantMessageForTurn"] =
    (input) =>
      hasProjectionThreadAssistantMessageRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.hasAssistantMessageForTurn:query",
          ),
        ),
        Effect.map((row) => row.exists === 1),
      );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const getLatestUserMessageAt: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAt"] = (
    input,
  ) =>
    getLatestUserMessageAtRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getLatestUserMessageAt:query"),
      ),
      Effect.map((row) => row.latestUserMessageAt),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    appendStreaming,
    getByMessageId,
    // T3-CUSTOM(expbkt3): atomic streaming-delta hot path.
    appendTextDelta,
    hasAssistantMessageForTurn,
    listByThreadId,
    getLatestUserMessageAt,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
