/**
 * T3-CUSTOM(expbkt3): persistence for review comments on assistant messages.
 *
 * A comment row is rewritten whole on every change (status, replies,
 * timestamps); comments are small and always read per thread, so a full-row
 * update keeps the repository free of partial-update variants. Numbering comes
 * from the per-thread settings row so removed comments never free their number.
 */
import {
  ThreadComment,
  ThreadCommentAnchor,
  ThreadCommentId,
  ThreadCommentReply,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export type ThreadCommentsRepositoryError = ProjectionRepositoryError;

export interface ThreadCommentSettings {
  readonly threadId: ThreadId;
  readonly deliveryPaused: boolean;
  readonly nextNumber: number;
}

const ThreadCommentDbRow = ThreadComment.mapFields(
  Struct.assign({
    anchor: Schema.fromJsonString(ThreadCommentAnchor),
    replies: Schema.fromJsonString(Schema.Array(ThreadCommentReply)),
  }),
);

const SettingsRow = Schema.Struct({
  threadId: ThreadId,
  deliveryPaused: Schema.Number,
  nextNumber: Schema.Number,
});

const NextNumberRow = Schema.Struct({ nextNumber: Schema.Number });

export class ThreadCommentsRepository extends Context.Service<
  ThreadCommentsRepository,
  {
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadComment>, ThreadCommentsRepositoryError>;
    readonly getComment: (input: {
      readonly threadId: ThreadId;
      readonly commentId: ThreadCommentId;
    }) => Effect.Effect<Option.Option<ThreadComment>, ThreadCommentsRepositoryError>;
    readonly insertComment: (
      comment: ThreadComment,
    ) => Effect.Effect<void, ThreadCommentsRepositoryError>;
    /** Rewrites the mutable columns of an existing row; a missing row is a no-op. */
    readonly updateComment: (
      comment: ThreadComment,
    ) => Effect.Effect<void, ThreadCommentsRepositoryError>;
    readonly deleteComment: (input: {
      readonly threadId: ThreadId;
      readonly commentId: ThreadCommentId;
    }) => Effect.Effect<void, ThreadCommentsRepositoryError>;
    /**
     * Marks every open or addressed comment on the thread resolved, or with
     * `only: "addressed"` just the ones the agent has marked done.
     */
    readonly resolveAll: (input: {
      readonly threadId: ThreadId;
      readonly resolvedAt: string;
      readonly only?: "addressed" | undefined;
    }) => Effect.Effect<void, ThreadCommentsRepositoryError>;
    readonly getSettings: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadCommentSettings, ThreadCommentsRepositoryError>;
    /** Hands out the thread's next display number and advances the counter. */
    readonly allocateNumber: (
      threadId: ThreadId,
    ) => Effect.Effect<number, ThreadCommentsRepositoryError>;
    readonly setDeliveryPaused: (input: {
      readonly threadId: ThreadId;
      readonly paused: boolean;
    }) => Effect.Effect<void, ThreadCommentsRepositoryError>;
    /**
     * Records that these comments went to the agent at `sentAt`. Each row is
     * marked only while it is unchanged since it was read (same `updatedAt`)
     * and still unsent, so a reply that landed in between keeps it unsent.
     */
    readonly markSent: (input: {
      readonly threadId: ThreadId;
      readonly comments: ReadonlyArray<Pick<ThreadComment, "commentId" | "updatedAt">>;
      readonly sentAt: string;
    }) => Effect.Effect<void, ThreadCommentsRepositoryError>;
    /** Clears the sent mark on every open comment, so the next turn sends them again. */
    readonly clearSentForOpen: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadCommentsRepositoryError>;
  }
>()("t3/persistence/ThreadComments/ThreadCommentsRepository") {}

function mapError(operation: string) {
  return (cause: unknown): ThreadCommentsRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const commentColumns = sql`
    comment_id AS "commentId",
    thread_id AS "threadId",
    number AS "number",
    kind AS "kind",
    anchor_json AS "anchor",
    body AS "body",
    status AS "status",
    author_user_id AS "authorUserId",
    author_label AS "authorLabel",
    replies_json AS "replies",
    created_at AS "createdAt",
    updated_at AS "updatedAt",
    resolved_at AS "resolvedAt",
    last_sent_at AS "lastSentAt"
  `;

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ThreadCommentDbRow,
    execute: ({ threadId }) => sql`
      SELECT ${commentColumns} FROM thread_comments
      WHERE thread_id = ${threadId}
      ORDER BY number ASC
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, commentId: ThreadCommentId }),
    Result: ThreadCommentDbRow,
    execute: ({ threadId, commentId }) => sql`
      SELECT ${commentColumns} FROM thread_comments
      WHERE comment_id = ${commentId} AND thread_id = ${threadId}
    `,
  });

  const insertRow = SqlSchema.void({
    Request: ThreadComment,
    execute: (comment) => sql`
      INSERT INTO thread_comments (
        comment_id, thread_id, number, kind, anchor_json, body, status,
        author_user_id, author_label, replies_json, created_at, updated_at, resolved_at,
        last_sent_at
      ) VALUES (
        ${comment.commentId}, ${comment.threadId}, ${comment.number}, ${comment.kind},
        ${JSON.stringify(comment.anchor)}, ${comment.body}, ${comment.status},
        ${comment.authorUserId}, ${comment.authorLabel}, ${JSON.stringify(comment.replies)},
        ${comment.createdAt}, ${comment.updatedAt}, ${comment.resolvedAt},
        ${comment.lastSentAt ?? null}
      )
      ON CONFLICT(comment_id) DO NOTHING
    `,
  });

  const updateRow = SqlSchema.void({
    Request: ThreadComment,
    execute: (comment) => sql`
      UPDATE thread_comments SET
        body = ${comment.body},
        status = ${comment.status},
        replies_json = ${JSON.stringify(comment.replies)},
        updated_at = ${comment.updatedAt},
        resolved_at = ${comment.resolvedAt},
        last_sent_at = ${comment.lastSentAt ?? null}
      WHERE comment_id = ${comment.commentId} AND thread_id = ${comment.threadId}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId, commentId: ThreadCommentId }),
    execute: ({ threadId, commentId }) => sql`
      DELETE FROM thread_comments
      WHERE comment_id = ${commentId} AND thread_id = ${threadId}
    `,
  });

  const resolveAllRows = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      resolvedAt: Schema.String,
      addressedOnly: Schema.Boolean,
    }),
    execute: ({ threadId, resolvedAt, addressedOnly }) => sql`
      UPDATE thread_comments SET
        status = 'resolved',
        updated_at = ${resolvedAt},
        resolved_at = ${resolvedAt}
      WHERE thread_id = ${threadId}
        AND ${sql.in("status", addressedOnly ? ["addressed"] : ["open", "addressed"])}
    `,
  });

  const getSettingsRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: SettingsRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        delivery_paused AS "deliveryPaused",
        next_number AS "nextNumber"
      FROM thread_comment_settings
      WHERE thread_id = ${threadId}
    `,
  });

  // The row is created on first use; RETURNING reads the number this call
  // claimed, so two concurrent adds on one thread never share a number.
  const allocateNumberRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: NextNumberRow,
    execute: ({ threadId }) => sql`
      INSERT INTO thread_comment_settings (thread_id, delivery_paused, next_number)
      VALUES (${threadId}, 0, 2)
      ON CONFLICT(thread_id) DO UPDATE SET next_number = next_number + 1
      RETURNING next_number - 1 AS "nextNumber"
    `,
  });

  const setDeliveryPausedRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId, paused: Schema.Number }),
    execute: ({ threadId, paused }) => sql`
      INSERT INTO thread_comment_settings (thread_id, delivery_paused, next_number)
      VALUES (${threadId}, ${paused}, 1)
      ON CONFLICT(thread_id) DO UPDATE SET delivery_paused = ${paused}
    `,
  });

  const markSentRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      commentId: ThreadCommentId,
      updatedAt: Schema.String,
      sentAt: Schema.String,
    }),
    execute: ({ threadId, commentId, updatedAt, sentAt }) => sql`
      UPDATE thread_comments SET last_sent_at = ${sentAt}
      WHERE thread_id = ${threadId}
        AND comment_id = ${commentId}
        AND updated_at = ${updatedAt}
        AND last_sent_at IS NULL
    `,
  });

  const clearSentForOpenRows = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`
      UPDATE thread_comments SET last_sent_at = NULL
      WHERE thread_id = ${threadId} AND status = 'open'
    `,
  });

  return ThreadCommentsRepository.of({
    listForThread: (threadId) =>
      listRows({ threadId }).pipe(Effect.mapError(mapError("ThreadComments.listForThread"))),

    getComment: (input) =>
      getRow(input).pipe(Effect.mapError(mapError("ThreadComments.getComment"))),

    insertComment: (comment) =>
      insertRow(comment).pipe(Effect.mapError(mapError("ThreadComments.insertComment"))),

    updateComment: (comment) =>
      updateRow(comment).pipe(Effect.mapError(mapError("ThreadComments.updateComment"))),

    deleteComment: (input) =>
      deleteRow(input).pipe(Effect.mapError(mapError("ThreadComments.deleteComment"))),

    resolveAll: ({ threadId, resolvedAt, only }) =>
      resolveAllRows({ threadId, resolvedAt, addressedOnly: only === "addressed" }).pipe(
        Effect.mapError(mapError("ThreadComments.resolveAll")),
      ),

    getSettings: (threadId) =>
      getSettingsRow({ threadId }).pipe(
        Effect.map(
          Option.match({
            onNone: (): ThreadCommentSettings => ({
              threadId,
              deliveryPaused: false,
              nextNumber: 1,
            }),
            onSome: (row): ThreadCommentSettings => ({
              threadId,
              deliveryPaused: row.deliveryPaused !== 0,
              nextNumber: row.nextNumber,
            }),
          }),
        ),
        Effect.mapError(mapError("ThreadComments.getSettings")),
      ),

    allocateNumber: (threadId) =>
      allocateNumberRows({ threadId }).pipe(
        Effect.flatMap((rows) =>
          rows.length === 1
            ? Effect.succeed(rows[0]!.nextNumber)
            : Effect.fail(
                new PersistenceSqlError({
                  operation: "ThreadComments.allocateNumber:query",
                  cause: new Error("Number allocation returned no row."),
                }),
              ),
        ),
        Effect.mapError(mapError("ThreadComments.allocateNumber")),
      ),

    setDeliveryPaused: ({ threadId, paused }) =>
      setDeliveryPausedRow({ threadId, paused: paused ? 1 : 0 }).pipe(
        Effect.mapError(mapError("ThreadComments.setDeliveryPaused")),
      ),

    markSent: ({ threadId, comments, sentAt }) =>
      Effect.forEach(
        comments,
        (comment) =>
          markSentRow({
            threadId,
            commentId: comment.commentId,
            updatedAt: comment.updatedAt,
            sentAt,
          }),
        { discard: true },
      ).pipe(Effect.mapError(mapError("ThreadComments.markSent"))),

    clearSentForOpen: (threadId) =>
      clearSentForOpenRows({ threadId }).pipe(
        Effect.mapError(mapError("ThreadComments.clearSentForOpen")),
      ),
  });
});

export const layer = Layer.effect(ThreadCommentsRepository, make);
