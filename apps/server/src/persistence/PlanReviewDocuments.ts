/**
 * T3-CUSTOM(expbkt3): persistence for native plan review.
 *
 * Three shapes live here: the document (one per plan lineage), its append-only
 * versions, and the mutable working draft plus discussion threads. Versions are
 * insert-only by contract — `appendVersion` fails on a duplicate `(documentId,
 * revision)` rather than overwriting, so history can never be rewritten by a
 * racing writer.
 */
import { ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const PlanDocumentStatus = Schema.Literals([
  "open",
  "approved",
  "changes-requested",
  "discarded",
]);
export type PlanDocumentStatus = typeof PlanDocumentStatus.Type;

export const PlanDocumentFormat = Schema.Literals(["md", "html"]);
export type PlanDocumentFormat = typeof PlanDocumentFormat.Type;

export const PlanVersionAuthorKind = Schema.Literals(["agent", "user"]);
export type PlanVersionAuthorKind = typeof PlanVersionAuthorKind.Type;

export const PlanVersionOrigin = Schema.Literals([
  "agent-proposed",
  "agent-revision",
  "human-edit",
]);
export type PlanVersionOrigin = typeof PlanVersionOrigin.Type;

export const PlanDocumentRecord = Schema.Struct({
  documentId: Schema.String,
  threadId: ThreadId,
  projectId: Schema.String,
  title: Schema.String,
  currentRevision: Schema.Number,
  status: PlanDocumentStatus,
  format: PlanDocumentFormat,
  createdByUserId: Schema.NullOr(UserId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PlanDocumentRecord = typeof PlanDocumentRecord.Type;

export const PlanVersionRecord = Schema.Struct({
  versionId: Schema.String,
  documentId: Schema.String,
  revision: Schema.Number,
  authorKind: PlanVersionAuthorKind,
  authorUserId: Schema.NullOr(UserId),
  origin: PlanVersionOrigin,
  contentMarkdown: Schema.String,
  contentValueJson: Schema.NullOr(Schema.String),
  sourcePlanId: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type PlanVersionRecord = typeof PlanVersionRecord.Type;

export const PlanDraftRecord = Schema.Struct({
  documentId: Schema.String,
  baseVersionId: Schema.String,
  contentValueJson: Schema.String,
  updatedByUserId: Schema.NullOr(UserId),
  updatedAt: Schema.String,
  revisionToken: Schema.String,
});
export type PlanDraftRecord = typeof PlanDraftRecord.Type;

export const PlanDiscussionRecord = Schema.Struct({
  discussionId: Schema.String,
  documentId: Schema.String,
  anchorVersionId: Schema.String,
  quotedText: Schema.String,
  isResolved: Schema.Boolean,
  resolvedByUserId: Schema.NullOr(UserId),
  resolvedAt: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(UserId),
  createdAt: Schema.String,
});
export type PlanDiscussionRecord = typeof PlanDiscussionRecord.Type;

export const PlanDiscussionCommentRecord = Schema.Struct({
  commentId: Schema.String,
  discussionId: Schema.String,
  authorUserId: Schema.NullOr(UserId),
  bodyMarkdown: Schema.String,
  isEdited: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PlanDiscussionCommentRecord = typeof PlanDiscussionCommentRecord.Type;

/** Raised when an append lost the race for a revision number. */
export class PlanVersionConflictError extends Schema.TaggedError<PlanVersionConflictError>()(
  "PlanVersionConflictError",
  { documentId: Schema.String, revision: Schema.Number },
) {}

/** Raised when a draft save carried a stale `revisionToken`. */
export class PlanDraftConflictError extends Schema.TaggedError<PlanDraftConflictError>()(
  "PlanDraftConflictError",
  { documentId: Schema.String },
) {}

export type PlanReviewRepositoryError = ProjectionRepositoryError;

const PlanDocumentRawRow = Schema.Struct({
  documentId: Schema.Unknown,
  threadId: Schema.Unknown,
  projectId: Schema.Unknown,
  title: Schema.Unknown,
  currentRevision: Schema.Unknown,
  status: Schema.Unknown,
  format: Schema.Unknown,
  createdByUserId: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const PlanVersionRawRow = Schema.Struct({
  versionId: Schema.Unknown,
  documentId: Schema.Unknown,
  revision: Schema.Unknown,
  authorKind: Schema.Unknown,
  authorUserId: Schema.Unknown,
  origin: Schema.Unknown,
  contentMarkdown: Schema.Unknown,
  contentValueJson: Schema.Unknown,
  sourcePlanId: Schema.Unknown,
  summary: Schema.Unknown,
  createdAt: Schema.Unknown,
});

const PlanDraftRawRow = Schema.Struct({
  documentId: Schema.Unknown,
  baseVersionId: Schema.Unknown,
  contentValueJson: Schema.Unknown,
  updatedByUserId: Schema.Unknown,
  updatedAt: Schema.Unknown,
  revisionToken: Schema.Unknown,
});

const PlanDiscussionRawRow = Schema.Struct({
  discussionId: Schema.Unknown,
  documentId: Schema.Unknown,
  anchorVersionId: Schema.Unknown,
  quotedText: Schema.Unknown,
  isResolved: Schema.Unknown,
  resolvedByUserId: Schema.Unknown,
  resolvedAt: Schema.Unknown,
  createdByUserId: Schema.Unknown,
  createdAt: Schema.Unknown,
});

const PlanDiscussionCommentRawRow = Schema.Struct({
  commentId: Schema.Unknown,
  discussionId: Schema.Unknown,
  authorUserId: Schema.Unknown,
  bodyMarkdown: Schema.Unknown,
  isEdited: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

export interface AppendVersionInput {
  readonly versionId: string;
  readonly documentId: string;
  readonly revision: number;
  readonly authorKind: PlanVersionAuthorKind;
  readonly authorUserId: UserId | null;
  readonly origin: PlanVersionOrigin;
  readonly contentMarkdown: string;
  readonly contentValueJson: string | null;
  readonly sourcePlanId: string | null;
  readonly summary: string | null;
  readonly createdAt: string;
}

export interface SaveDraftInput {
  readonly documentId: string;
  readonly baseVersionId: string;
  readonly contentValueJson: string;
  readonly updatedByUserId: UserId | null;
  readonly updatedAt: string;
  readonly expectedRevisionToken: string | null;
  readonly nextRevisionToken: string;
}

export interface UpsertDiscussionInput {
  readonly discussionId: string;
  readonly documentId: string;
  readonly anchorVersionId: string;
  readonly quotedText: string;
  readonly createdByUserId: UserId | null;
  readonly createdAt: string;
}

export interface AddDiscussionCommentInput {
  readonly commentId: string;
  readonly discussionId: string;
  readonly documentId: string;
  readonly authorUserId: UserId | null;
  readonly bodyMarkdown: string;
  readonly createdAt: string;
}

export interface ResolveDiscussionInput {
  readonly discussionId: string;
  readonly documentId: string;
  readonly isResolved: boolean;
  readonly resolvedByUserId: UserId | null;
  readonly resolvedAt: string | null;
}

export class PlanReviewRepository extends Context.Service<
  PlanReviewRepository,
  {
    readonly upsertDocument: (
      input: PlanDocumentRecord,
    ) => Effect.Effect<void, PlanReviewRepositoryError>;
    readonly getDocument: (
      documentId: string,
    ) => Effect.Effect<Option.Option<PlanDocumentRecord>, PlanReviewRepositoryError>;
    readonly listDocumentsForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PlanDocumentRecord>, PlanReviewRepositoryError>;
    readonly findDocumentBySourcePlanId: (
      sourcePlanId: string,
    ) => Effect.Effect<Option.Option<PlanDocumentRecord>, PlanReviewRepositoryError>;
    readonly setDocumentStatus: (input: {
      readonly documentId: string;
      readonly status: PlanDocumentStatus;
      readonly updatedAt: string;
    }) => Effect.Effect<void, PlanReviewRepositoryError>;
    readonly appendVersion: (
      input: AppendVersionInput,
    ) => Effect.Effect<void, PlanReviewRepositoryError | PlanVersionConflictError>;
    readonly listVersions: (
      documentId: string,
    ) => Effect.Effect<ReadonlyArray<PlanVersionRecord>, PlanReviewRepositoryError>;
    readonly getVersion: (input: {
      readonly documentId: string;
      readonly versionId: string;
    }) => Effect.Effect<Option.Option<PlanVersionRecord>, PlanReviewRepositoryError>;
    readonly getLatestVersion: (
      documentId: string,
    ) => Effect.Effect<Option.Option<PlanVersionRecord>, PlanReviewRepositoryError>;
    readonly getDraft: (
      documentId: string,
    ) => Effect.Effect<Option.Option<PlanDraftRecord>, PlanReviewRepositoryError>;
    readonly saveDraft: (
      input: SaveDraftInput,
    ) => Effect.Effect<void, PlanReviewRepositoryError | PlanDraftConflictError>;
    readonly clearDraft: (documentId: string) => Effect.Effect<void, PlanReviewRepositoryError>;
    readonly upsertDiscussion: (
      input: UpsertDiscussionInput,
    ) => Effect.Effect<void, PlanReviewRepositoryError>;
    readonly listDiscussions: (
      documentId: string,
    ) => Effect.Effect<ReadonlyArray<PlanDiscussionRecord>, PlanReviewRepositoryError>;
    readonly resolveDiscussion: (
      input: ResolveDiscussionInput,
    ) => Effect.Effect<void, PlanReviewRepositoryError>;
    readonly addDiscussionComment: (
      input: AddDiscussionCommentInput,
    ) => Effect.Effect<void, PlanReviewRepositoryError>;
    readonly listDiscussionComments: (
      documentId: string,
    ) => Effect.Effect<ReadonlyArray<PlanDiscussionCommentRecord>, PlanReviewRepositoryError>;
  }
>()("t3/persistence/PlanReviewDocuments/PlanReviewRepository") {}

function mapError(operation: string) {
  return (cause: unknown): PlanReviewRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

const decodeDocument = Schema.decodeUnknownEffect(PlanDocumentRecord);
const decodeVersion = Schema.decodeUnknownEffect(PlanVersionRecord);
const decodeDraft = Schema.decodeUnknownEffect(PlanDraftRecord);
const decodeDiscussion = Schema.decodeUnknownEffect(PlanDiscussionRecord);
const decodeComment = Schema.decodeUnknownEffect(PlanDiscussionCommentRecord);

/** SQLite stores booleans as 0/1; normalise before schema decoding. */
function withBoolean<K extends string>(row: Record<string, unknown>, key: K) {
  return { ...row, [key]: row[key] === 1 || row[key] === true };
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const documentColumns = sql`
    document_id AS "documentId",
    thread_id AS "threadId",
    project_id AS "projectId",
    title AS "title",
    current_revision AS "currentRevision",
    status AS "status",
    format AS "format",
    created_by_user_id AS "createdByUserId",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const versionColumns = sql`
    version_id AS "versionId",
    document_id AS "documentId",
    revision AS "revision",
    author_kind AS "authorKind",
    author_user_id AS "authorUserId",
    origin AS "origin",
    content_markdown AS "contentMarkdown",
    content_value_json AS "contentValueJson",
    source_plan_id AS "sourcePlanId",
    summary AS "summary",
    created_at AS "createdAt"
  `;

  const discussionColumns = sql`
    discussion_id AS "discussionId",
    document_id AS "documentId",
    anchor_version_id AS "anchorVersionId",
    quoted_text AS "quotedText",
    is_resolved AS "isResolved",
    resolved_by_user_id AS "resolvedByUserId",
    resolved_at AS "resolvedAt",
    created_by_user_id AS "createdByUserId",
    created_at AS "createdAt"
  `;

  const upsertDocumentRow = SqlSchema.void({
    Request: PlanDocumentRecord,
    execute: (input) => sql`
      INSERT INTO plan_documents (
        document_id, thread_id, project_id, title, current_revision,
        status, format, created_by_user_id, created_at, updated_at
      ) VALUES (
        ${input.documentId}, ${input.threadId}, ${input.projectId}, ${input.title},
        ${input.currentRevision}, ${input.status}, ${input.format}, ${input.createdByUserId},
        ${input.createdAt}, ${input.updatedAt}
      )
      ON CONFLICT(document_id) DO UPDATE SET
        title = excluded.title,
        current_revision = excluded.current_revision,
        status = excluded.status,
        format = excluded.format,
        updated_at = excluded.updated_at
    `,
  });

  const getDocumentRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ documentId: Schema.String }),
    Result: PlanDocumentRawRow,
    execute: ({ documentId }) => sql`
      SELECT ${documentColumns} FROM plan_documents WHERE document_id = ${documentId}
    `,
  });

  const listDocumentsForThreadRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: PlanDocumentRawRow,
    execute: ({ threadId }) => sql`
      SELECT ${documentColumns} FROM plan_documents
      WHERE thread_id = ${threadId}
      ORDER BY created_at DESC
    `,
  });

  const findDocumentBySourcePlanIdRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ sourcePlanId: Schema.String }),
    Result: PlanDocumentRawRow,
    execute: ({ sourcePlanId }) => sql`
      SELECT ${documentColumns} FROM plan_documents
      WHERE document_id = (
        SELECT document_id FROM plan_document_versions
        WHERE source_plan_id = ${sourcePlanId}
        ORDER BY revision DESC LIMIT 1
      )
    `,
  });

  const setDocumentStatusRow = SqlSchema.void({
    Request: Schema.Struct({
      documentId: Schema.String,
      status: PlanDocumentStatus,
      updatedAt: Schema.String,
    }),
    execute: ({ documentId, status, updatedAt }) => sql`
      UPDATE plan_documents
      SET status = ${status}, updated_at = ${updatedAt}
      WHERE document_id = ${documentId}
    `,
  });

  // INSERT ... SELECT WHERE NOT EXISTS keeps the duplicate check inside SQLite,
  // so two concurrent appends cannot both believe they won the revision.
  const appendVersionRow = SqlSchema.findAll({
    Request: Schema.Struct({
      versionId: Schema.String,
      documentId: Schema.String,
      revision: Schema.Number,
      authorKind: PlanVersionAuthorKind,
      authorUserId: Schema.NullOr(UserId),
      origin: PlanVersionOrigin,
      contentMarkdown: Schema.String,
      contentValueJson: Schema.NullOr(Schema.String),
      sourcePlanId: Schema.NullOr(Schema.String),
      summary: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
    Result: Schema.Struct({ versionId: Schema.String }),
    execute: (input) => sql`
      INSERT INTO plan_document_versions (
        version_id, document_id, revision, author_kind, author_user_id,
        origin, content_markdown, content_value_json, source_plan_id, summary, created_at
      )
      SELECT
        ${input.versionId}, ${input.documentId}, ${input.revision}, ${input.authorKind},
        ${input.authorUserId}, ${input.origin}, ${input.contentMarkdown},
        ${input.contentValueJson}, ${input.sourcePlanId}, ${input.summary}, ${input.createdAt}
      WHERE NOT EXISTS (
        SELECT 1 FROM plan_document_versions
        WHERE document_id = ${input.documentId} AND revision = ${input.revision}
      )
      RETURNING version_id AS "versionId"
    `,
  });

  const listVersionRows = SqlSchema.findAll({
    Request: Schema.Struct({ documentId: Schema.String }),
    Result: PlanVersionRawRow,
    execute: ({ documentId }) => sql`
      SELECT ${versionColumns} FROM plan_document_versions
      WHERE document_id = ${documentId}
      ORDER BY revision ASC
    `,
  });

  const getVersionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ versionId: Schema.String, documentId: Schema.String }),
    Result: PlanVersionRawRow,
    execute: ({ versionId, documentId }) => sql`
      SELECT ${versionColumns} FROM plan_document_versions
      WHERE version_id = ${versionId} AND document_id = ${documentId}
    `,
  });

  const getLatestVersionRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ documentId: Schema.String }),
    Result: PlanVersionRawRow,
    execute: ({ documentId }) => sql`
      SELECT ${versionColumns} FROM plan_document_versions
      WHERE document_id = ${documentId}
      ORDER BY revision DESC LIMIT 1
    `,
  });

  const getDraftRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ documentId: Schema.String }),
    Result: PlanDraftRawRow,
    execute: ({ documentId }) => sql`
      SELECT
        document_id AS "documentId",
        base_version_id AS "baseVersionId",
        content_value_json AS "contentValueJson",
        updated_by_user_id AS "updatedByUserId",
        updated_at AS "updatedAt",
        revision_token AS "revisionToken"
      FROM plan_document_drafts WHERE document_id = ${documentId}
    `,
  });

  // The WHERE clause is the concurrency guard: a save whose expected token no
  // longer matches the stored one touches zero rows and surfaces as a conflict.
  const saveDraftRow = SqlSchema.findAll({
    Request: Schema.Struct({
      documentId: Schema.String,
      baseVersionId: Schema.String,
      contentValueJson: Schema.String,
      updatedByUserId: Schema.NullOr(UserId),
      updatedAt: Schema.String,
      expectedRevisionToken: Schema.NullOr(Schema.String),
      nextRevisionToken: Schema.String,
    }),
    Result: Schema.Struct({ documentId: Schema.String }),
    execute: (input) => sql`
      INSERT INTO plan_document_drafts (
        document_id, base_version_id, content_value_json,
        updated_by_user_id, updated_at, revision_token
      )
      SELECT
        ${input.documentId}, ${input.baseVersionId}, ${input.contentValueJson},
        ${input.updatedByUserId}, ${input.updatedAt}, ${input.nextRevisionToken}
      WHERE (
              ${input.expectedRevisionToken} IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM plan_document_drafts WHERE document_id = ${input.documentId}
              )
            )
         OR ${input.expectedRevisionToken} = (
              SELECT revision_token FROM plan_document_drafts WHERE document_id = ${input.documentId}
            )
      ON CONFLICT(document_id) DO UPDATE SET
        base_version_id = excluded.base_version_id,
        content_value_json = excluded.content_value_json,
        updated_by_user_id = excluded.updated_by_user_id,
        updated_at = excluded.updated_at,
        revision_token = excluded.revision_token
      RETURNING document_id AS "documentId"
    `,
  });

  const clearDraftRow = SqlSchema.void({
    Request: Schema.Struct({ documentId: Schema.String }),
    execute: ({ documentId }) => sql`
      DELETE FROM plan_document_drafts WHERE document_id = ${documentId}
    `,
  });

  const upsertDiscussionRow = SqlSchema.findAll({
    Result: Schema.Struct({ discussionId: Schema.String }),
    Request: Schema.Struct({
      discussionId: Schema.String,
      documentId: Schema.String,
      anchorVersionId: Schema.String,
      quotedText: Schema.String,
      createdByUserId: Schema.NullOr(UserId),
      createdAt: Schema.String,
    }),
    execute: (input) => sql`
      INSERT INTO plan_discussions (
        discussion_id, document_id, anchor_version_id, quoted_text,
        is_resolved, resolved_by_user_id, resolved_at, created_by_user_id, created_at
      ) VALUES (
        ${input.discussionId}, ${input.documentId}, ${input.anchorVersionId},
        ${input.quotedText}, 0, NULL, NULL, ${input.createdByUserId}, ${input.createdAt}
      )
      ON CONFLICT(discussion_id) DO UPDATE SET
        anchor_version_id = excluded.anchor_version_id,
        quoted_text = excluded.quoted_text
      WHERE plan_discussions.document_id = excluded.document_id
      RETURNING discussion_id AS "discussionId"
    `,
  });

  const listDiscussionRows = SqlSchema.findAll({
    Request: Schema.Struct({ documentId: Schema.String }),
    Result: PlanDiscussionRawRow,
    execute: ({ documentId }) => sql`
      SELECT ${discussionColumns} FROM plan_discussions
      WHERE document_id = ${documentId}
      ORDER BY created_at ASC
    `,
  });

  // Every discussion statement is scoped by document_id as well as by its own
  // id. Callers authorize the document, so an id that belongs to a different
  // document must not be reachable through it.
  const resolveDiscussionRow = SqlSchema.findAll({
    Request: Schema.Struct({
      discussionId: Schema.String,
      documentId: Schema.String,
      isResolved: Schema.Boolean,
      resolvedByUserId: Schema.NullOr(UserId),
      resolvedAt: Schema.NullOr(Schema.String),
    }),
    Result: Schema.Struct({ discussionId: Schema.String }),
    execute: (input) => sql`
      UPDATE plan_discussions
      SET is_resolved = ${input.isResolved ? 1 : 0},
          resolved_by_user_id = ${input.resolvedByUserId},
          resolved_at = ${input.resolvedAt}
      WHERE discussion_id = ${input.discussionId}
        AND document_id = ${input.documentId}
      RETURNING discussion_id AS "discussionId"
    `,
  });

  const addDiscussionCommentRow = SqlSchema.findAll({
    Request: Schema.Struct({
      commentId: Schema.String,
      discussionId: Schema.String,
      documentId: Schema.String,
      authorUserId: Schema.NullOr(UserId),
      bodyMarkdown: Schema.String,
      createdAt: Schema.String,
    }),
    Result: Schema.Struct({ commentId: Schema.String }),
    execute: (input) => sql`
      INSERT INTO plan_discussion_comments (
        comment_id, discussion_id, author_user_id, body_markdown,
        is_edited, created_at, updated_at
      )
      SELECT
        ${input.commentId}, ${input.discussionId}, ${input.authorUserId},
        ${input.bodyMarkdown}, 0, ${input.createdAt}, ${input.createdAt}
      WHERE EXISTS (
        SELECT 1 FROM plan_discussions
        WHERE discussion_id = ${input.discussionId} AND document_id = ${input.documentId}
      )
      ON CONFLICT(comment_id) DO UPDATE SET
        body_markdown = excluded.body_markdown,
        is_edited = 1,
        updated_at = excluded.updated_at
      RETURNING comment_id AS "commentId"
    `,
  });

  const listDiscussionCommentRows = SqlSchema.findAll({
    Request: Schema.Struct({ documentId: Schema.String }),
    Result: PlanDiscussionCommentRawRow,
    execute: ({ documentId }) => sql`
      SELECT
        c.comment_id AS "commentId",
        c.discussion_id AS "discussionId",
        c.author_user_id AS "authorUserId",
        c.body_markdown AS "bodyMarkdown",
        c.is_edited AS "isEdited",
        c.created_at AS "createdAt",
        c.updated_at AS "updatedAt"
      FROM plan_discussion_comments c
      JOIN plan_discussions d ON d.discussion_id = c.discussion_id
      WHERE d.document_id = ${documentId}
      ORDER BY c.created_at ASC
    `,
  });

  const decodeMany = <A>(
    rows: ReadonlyArray<unknown>,
    decode: (row: unknown) => Effect.Effect<A, Schema.SchemaError>,
    operation: string,
  ): Effect.Effect<ReadonlyArray<A>, PlanReviewRepositoryError> =>
    Effect.forEach(rows, (row) => decode(row).pipe(Effect.mapError(mapError(operation))));

  const service: PlanReviewRepository["Service"] = {
    upsertDocument: (input) =>
      upsertDocumentRow(input).pipe(Effect.mapError(mapError("PlanReview.upsertDocument"))),

    getDocument: (documentId) =>
      getDocumentRow({ documentId }).pipe(
        Effect.mapError(mapError("PlanReview.getDocument")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeDocument(row).pipe(
                Effect.map(Option.some),
                Effect.mapError(mapError("PlanReview.getDocument")),
              ),
          }),
        ),
      ),

    listDocumentsForThread: (threadId) =>
      listDocumentsForThreadRows({ threadId }).pipe(
        Effect.mapError(mapError("PlanReview.listDocumentsForThread")),
        Effect.flatMap((rows) =>
          decodeMany(rows, decodeDocument, "PlanReview.listDocumentsForThread"),
        ),
      ),

    findDocumentBySourcePlanId: (sourcePlanId) =>
      findDocumentBySourcePlanIdRow({ sourcePlanId }).pipe(
        Effect.mapError(mapError("PlanReview.findDocumentBySourcePlanId")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeDocument(row).pipe(
                Effect.map(Option.some),
                Effect.mapError(mapError("PlanReview.findDocumentBySourcePlanId")),
              ),
          }),
        ),
      ),

    setDocumentStatus: (input) =>
      setDocumentStatusRow(input).pipe(Effect.mapError(mapError("PlanReview.setDocumentStatus"))),

    appendVersion: (input) =>
      appendVersionRow(input).pipe(
        Effect.mapError(mapError("PlanReview.appendVersion")),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : Effect.fail(
                new PlanVersionConflictError({
                  documentId: input.documentId,
                  revision: input.revision,
                }),
              ),
        ),
      ),

    listVersions: (documentId) =>
      listVersionRows({ documentId }).pipe(
        Effect.mapError(mapError("PlanReview.listVersions")),
        Effect.flatMap((rows) => decodeMany(rows, decodeVersion, "PlanReview.listVersions")),
      ),

    getVersion: (input) =>
      getVersionRow(input).pipe(
        Effect.mapError(mapError("PlanReview.getVersion")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeVersion(row).pipe(
                Effect.map(Option.some),
                Effect.mapError(mapError("PlanReview.getVersion")),
              ),
          }),
        ),
      ),

    getLatestVersion: (documentId) =>
      getLatestVersionRow({ documentId }).pipe(
        Effect.mapError(mapError("PlanReview.getLatestVersion")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeVersion(row).pipe(
                Effect.map(Option.some),
                Effect.mapError(mapError("PlanReview.getLatestVersion")),
              ),
          }),
        ),
      ),

    getDraft: (documentId) =>
      getDraftRow({ documentId }).pipe(
        Effect.mapError(mapError("PlanReview.getDraft")),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeDraft(row).pipe(
                Effect.map(Option.some),
                Effect.mapError(mapError("PlanReview.getDraft")),
              ),
          }),
        ),
      ),

    saveDraft: (input) =>
      saveDraftRow(input).pipe(
        Effect.mapError(mapError("PlanReview.saveDraft")),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : Effect.fail(new PlanDraftConflictError({ documentId: input.documentId })),
        ),
      ),

    clearDraft: (documentId) =>
      clearDraftRow({ documentId }).pipe(Effect.mapError(mapError("PlanReview.clearDraft"))),

    upsertDiscussion: (input) =>
      upsertDiscussionRow(input).pipe(
        Effect.mapError(mapError("PlanReview.upsertDiscussion")),
        Effect.asVoid,
      ),

    listDiscussions: (documentId) =>
      listDiscussionRows({ documentId }).pipe(
        Effect.mapError(mapError("PlanReview.listDiscussions")),
        Effect.flatMap((rows) =>
          decodeMany(
            rows.map((row) => withBoolean(row as Record<string, unknown>, "isResolved")),
            decodeDiscussion,
            "PlanReview.listDiscussions",
          ),
        ),
      ),

    resolveDiscussion: (input) =>
      resolveDiscussionRow(input).pipe(
        Effect.mapError(mapError("PlanReview.resolveDiscussion")),
        Effect.asVoid,
      ),

    addDiscussionComment: (input) =>
      addDiscussionCommentRow(input).pipe(
        Effect.mapError(mapError("PlanReview.addDiscussionComment")),
        Effect.asVoid,
      ),

    listDiscussionComments: (documentId) =>
      listDiscussionCommentRows({ documentId }).pipe(
        Effect.mapError(mapError("PlanReview.listDiscussionComments")),
        Effect.flatMap((rows) =>
          decodeMany(
            rows.map((row) => withBoolean(row as Record<string, unknown>, "isEdited")),
            decodeComment,
            "PlanReview.listDiscussionComments",
          ),
        ),
      ),
  };

  return PlanReviewRepository.of(service);
});

export const layer = Layer.effect(PlanReviewRepository, make);
