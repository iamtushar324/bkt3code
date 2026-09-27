/**
 * T3-CUSTOM(expbkt3): contracts for native plan review.
 *
 * Plan review is not an orchestration aggregate — it lives in fork-owned tables
 * reached over fork RPC, so these schemas stay out of `orchestration.ts` and
 * cost nothing at upstream merge time.
 */
import * as Schema from "effect/Schema";

import { ThreadId, UserId } from "./baseSchemas.ts";

export const PlanReviewStatus = Schema.Literals([
  "open",
  "approved",
  "changes-requested",
  "discarded",
]);
export type PlanReviewStatus = typeof PlanReviewStatus.Type;

export const PlanReviewFormat = Schema.Literals(["md", "html"]);
export type PlanReviewFormat = typeof PlanReviewFormat.Type;

export const PlanReviewAuthorKind = Schema.Literals(["agent", "user"]);
export type PlanReviewAuthorKind = typeof PlanReviewAuthorKind.Type;

export const PlanReviewVersionOrigin = Schema.Literals([
  "agent-proposed",
  "agent-revision",
  "human-edit",
]);
export type PlanReviewVersionOrigin = typeof PlanReviewVersionOrigin.Type;

export const PlanReviewDecision = Schema.Literals(["approved", "changes-requested", "discarded"]);
export type PlanReviewDecision = typeof PlanReviewDecision.Type;

export const PlanReviewDocument = Schema.Struct({
  documentId: Schema.String,
  threadId: ThreadId,
  projectId: Schema.String,
  title: Schema.String,
  currentRevision: Schema.Number,
  status: PlanReviewStatus,
  format: PlanReviewFormat,
  createdByUserId: Schema.NullOr(UserId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PlanReviewDocument = typeof PlanReviewDocument.Type;

export const PlanReviewVersion = Schema.Struct({
  versionId: Schema.String,
  documentId: Schema.String,
  revision: Schema.Number,
  authorKind: PlanReviewAuthorKind,
  authorUserId: Schema.NullOr(UserId),
  origin: PlanReviewVersionOrigin,
  contentMarkdown: Schema.String,
  contentValueJson: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type PlanReviewVersion = typeof PlanReviewVersion.Type;

export const PlanReviewDraft = Schema.Struct({
  contentValueJson: Schema.String,
  baseVersionId: Schema.String,
  revisionToken: Schema.String,
  updatedByUserId: Schema.NullOr(UserId),
  updatedAt: Schema.String,
});
export type PlanReviewDraft = typeof PlanReviewDraft.Type;

export const PlanReviewComment = Schema.Struct({
  commentId: Schema.String,
  discussionId: Schema.String,
  authorUserId: Schema.NullOr(UserId),
  bodyMarkdown: Schema.String,
  isEdited: Schema.Boolean,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PlanReviewComment = typeof PlanReviewComment.Type;

export const PlanReviewDiscussion = Schema.Struct({
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
export type PlanReviewDiscussion = typeof PlanReviewDiscussion.Type;

export const PlanReviewSnapshotResult = Schema.Struct({
  document: PlanReviewDocument,
  versions: Schema.Array(PlanReviewVersion),
  draft: Schema.NullOr(PlanReviewDraft),
  discussions: Schema.Array(PlanReviewDiscussion),
  comments: Schema.Array(PlanReviewComment),
});
export type PlanReviewSnapshotResult = typeof PlanReviewSnapshotResult.Type;

export const PlanReviewListResult = Schema.Struct({
  documents: Schema.Array(PlanReviewDocument),
});
export type PlanReviewListResult = typeof PlanReviewListResult.Type;

export const PlanReviewDocumentIdInput = Schema.Struct({
  documentId: Schema.String,
});

export const PlanReviewListInput = Schema.Struct({
  threadId: ThreadId,
});

export const PlanReviewSaveDraftInput = Schema.Struct({
  documentId: Schema.String,
  contentValueJson: Schema.String,
  /** Null on the first save for a document. */
  expectedRevisionToken: Schema.NullOr(Schema.String),
});

export const PlanReviewSaveDraftResult = Schema.Struct({
  revisionToken: Schema.String,
});

export const PlanReviewCutVersionInput = Schema.Struct({
  documentId: Schema.String,
  contentMarkdown: Schema.String,
  contentValueJson: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
});

export const PlanReviewUpsertDiscussionInput = Schema.Struct({
  documentId: Schema.String,
  discussionId: Schema.String,
  quotedText: Schema.String,
  bodyMarkdown: Schema.String,
});

export const PlanReviewResolveDiscussionInput = Schema.Struct({
  documentId: Schema.String,
  discussionId: Schema.String,
  isResolved: Schema.Boolean,
});

export const PlanReviewVersionDiffInput = Schema.Struct({
  documentId: Schema.String,
  fromVersionId: Schema.String,
  toVersionId: Schema.String,
});

export const PlanReviewVersionDiffResult = Schema.Struct({
  diff: Schema.String,
});

export const PlanReviewSubmitInput = Schema.Struct({
  documentId: Schema.String,
  decision: PlanReviewDecision,
  globalComment: Schema.String,
  /** Reviewer-edited markdown; null when the plan was not edited. */
  editedMarkdown: Schema.NullOr(Schema.String),
});

export const PlanReviewSubmitResult = Schema.Struct({
  documentId: Schema.String,
  status: PlanReviewStatus,
  /** The exact text handed to the agent, so the UI can show what was sent. */
  prompt: Schema.NullOr(Schema.String),
  turnStarted: Schema.Boolean,
  /** True when the policy decided the plan body had to be repeated. */
  resentPlan: Schema.Boolean,
});

export const PlanReviewErrorReason = Schema.Literals([
  "not-found",
  "draft-conflict",
  "version-conflict",
  "invalid",
]);
export type PlanReviewErrorReason = typeof PlanReviewErrorReason.Type;

export class PlanReviewError extends Schema.TaggedError<PlanReviewError>()("PlanReviewError", {
  operation: Schema.String,
  reason: PlanReviewErrorReason,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Plan review ${this.operation} failed: ${this.detail}`;
  }
}
