/**
 * T3-CUSTOM(expbkt3): native plan review service.
 *
 * Owns the plan document lifecycle: capture the agent's plan as version 1,
 * accumulate attributed human edits and discussions, cut new versions, and
 * feed the outcome back into the thread as a normal turn. Nothing here is an
 * orchestration aggregate — the review lives in fork-owned tables and reaches
 * the thread only through the existing `thread.activity.append` and
 * `thread.turn.start` commands, so upstream contracts are untouched.
 */
import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProposedPlanId,
  type UserId,
} from "@t3tools/contracts";
import {
  buildPlanReviewApprovalPrompt,
  buildPlanReviewFeedbackPrompt,
  locateQuotedLineRange,
  type PlanReviewAnchoredComment,
} from "@t3tools/shared/planReview";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration-v2/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration-v2/Services/ProjectionSnapshotQuery.ts";
import {
  PlanDraftConflictError,
  PlanReviewRepository,
  PlanVersionConflictError,
  type PlanDiscussionCommentRecord,
  type PlanDiscussionRecord,
  type PlanDocumentRecord,
  type PlanDocumentStatus,
  type PlanVersionRecord,
} from "../persistence/PlanReviewDocuments.ts";
import { buildUnifiedDiff, toRenderableFileDiff } from "./planReviewDiff.ts";
import { decidePlanResend } from "./PlanReviewContextPolicy.ts";
import { detectPlanFormat, withoutLegacyReviewMarker } from "./planFormat.ts";

export class PlanReviewNotFoundError extends Schema.TaggedError<PlanReviewNotFoundError>()(
  "PlanReviewNotFoundError",
  { documentId: Schema.String },
) {}

export class PlanReviewInvariantError extends Schema.TaggedError<PlanReviewInvariantError>()(
  "PlanReviewInvariantError",
  { operation: Schema.String, detail: Schema.String },
) {}

export type PlanReviewServiceError =
  | PlanReviewNotFoundError
  | PlanReviewInvariantError
  | PlanDraftConflictError
  | PlanVersionConflictError;

export interface PlanReviewSnapshot {
  readonly document: PlanDocumentRecord;
  readonly versions: ReadonlyArray<PlanVersionRecord>;
  readonly draft: {
    readonly contentValueJson: string;
    readonly baseVersionId: string;
    readonly revisionToken: string;
    readonly updatedByUserId: UserId | null;
    readonly updatedAt: string;
  } | null;
  readonly discussions: ReadonlyArray<PlanDiscussionRecord>;
  readonly comments: ReadonlyArray<PlanDiscussionCommentRecord>;
}

export interface CapturePlanInput {
  readonly threadId: ThreadId;
  readonly projectId: string;
  readonly planId: OrchestrationProposedPlanId;
  readonly planMarkdown: string;
  readonly title: string;
  /** Null for agent-authored versions. */
  readonly authorUserId: UserId | null;
}

export interface SubmitReviewInput {
  readonly documentId: string;
  readonly decision: "approved" | "changes-requested" | "discarded";
  readonly globalComment: string;
  /** Reviewer-edited markdown, when the plan was edited. */
  readonly editedMarkdown: string | null;
  readonly actorUserId: UserId | null;
  readonly actorLabel: string | null;
}

export interface SubmitReviewResult {
  readonly documentId: string;
  readonly status: PlanDocumentStatus;
  /** The exact text handed to the agent, so tests and the UI can assert it. */
  readonly prompt: string | null;
  readonly turnStarted: boolean;
  readonly resentPlan: boolean;
}

export class PlanReviewService extends Context.Service<
  PlanReviewService,
  {
    readonly capturePlan: (
      input: CapturePlanInput,
    ) => Effect.Effect<PlanDocumentRecord, PlanReviewServiceError>;
    readonly getReview: (
      documentId: string,
    ) => Effect.Effect<PlanReviewSnapshot, PlanReviewServiceError>;
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PlanDocumentRecord>, PlanReviewServiceError>;
    readonly saveDraft: (input: {
      readonly documentId: string;
      readonly contentValueJson: string;
      readonly expectedRevisionToken: string | null;
      readonly actorUserId: UserId | null;
    }) => Effect.Effect<{ readonly revisionToken: string }, PlanReviewServiceError>;
    readonly cutVersion: (input: {
      readonly documentId: string;
      readonly contentMarkdown: string;
      readonly contentValueJson: string | null;
      readonly summary: string | null;
      readonly actorUserId: UserId | null;
    }) => Effect.Effect<PlanVersionRecord, PlanReviewServiceError>;
    readonly upsertDiscussion: (input: {
      readonly documentId: string;
      readonly discussionId: string;
      readonly quotedText: string;
      readonly bodyMarkdown: string;
      readonly actorUserId: UserId | null;
    }) => Effect.Effect<void, PlanReviewServiceError>;
    readonly resolveDiscussion: (input: {
      readonly documentId: string;
      readonly discussionId: string;
      readonly isResolved: boolean;
      readonly actorUserId: UserId | null;
    }) => Effect.Effect<void, PlanReviewServiceError>;
    readonly getVersionDiff: (input: {
      readonly documentId: string;
      readonly fromVersionId: string;
      readonly toVersionId: string;
    }) => Effect.Effect<{ readonly diff: string }, PlanReviewServiceError>;
    readonly submit: (
      input: SubmitReviewInput,
    ) => Effect.Effect<SubmitReviewResult, PlanReviewServiceError>;
    /**
     * Emits a snapshot for `documentId` on subscribe and again after every
     * mutation from any client, so open panels converge without polling.
     */
    readonly watch: (
      documentId: string,
    ) => Stream.Stream<PlanReviewSnapshot, PlanReviewServiceError>;
  }
>()("t3/planreview/PlanReviewService") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** First heading, else first non-empty line, capped so titles stay tab-sized. */
export function derivePlanTitle(markdown: string): string {
  if (detectPlanFormat(markdown) === "html") {
    const titled =
      /<title[^>]*>([\s\S]*?)<\/title>/i.exec(markdown) ??
      /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(markdown);
    const text = titled?.[1]
      ?.replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.length > 80 ? `${text.slice(0, 77)}…` : text;
    return "HTML plan";
  }

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const candidate = (heading?.[1] ?? line).trim();
    if (candidate.length === 0) continue;
    return candidate.length > 80 ? `${candidate.slice(0, 77)}…` : candidate;
  }
  return "Plan";
}

export const make = Effect.gen(function* () {
  const repository = yield* PlanReviewRepository;
  const dispatcher = yield* OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  // A failing CSPRNG is a defect, not something a caller can recover from.
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  // Mutations announce the document they touched; `watch` re-reads from there.
  const changes = yield* PubSub.unbounded<string>();
  const announce = (documentId: string) => PubSub.publish(changes, documentId).pipe(Effect.ignore);

  /**
   * Repository and platform failures are infrastructure detail the caller
   * cannot act on, so they collapse into one invariant error. The two conflict
   * errors are the exception: callers retry or surface them to the reviewer.
   */
  const asInvariant =
    (operation: string) =>
    <A, E extends { readonly _tag: string; readonly message: string }, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, PlanReviewServiceError, R> =>
      effect.pipe(
        Effect.mapError((cause): PlanReviewServiceError =>
          cause._tag === "PlanDraftConflictError" || cause._tag === "PlanVersionConflictError"
            ? (cause as unknown as PlanDraftConflictError | PlanVersionConflictError)
            : new PlanReviewInvariantError({ operation, detail: cause.message }),
        ),
      );

  const requireDocument = (documentId: string) =>
    repository.getDocument(documentId).pipe(
      asInvariant("getDocument"),
      Effect.flatMap(
        Option.match({
          onNone: (): Effect.Effect<PlanDocumentRecord, PlanReviewServiceError> =>
            Effect.fail(new PlanReviewNotFoundError({ documentId })),
          onSome: Effect.succeed,
        }),
      ),
    );

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly summary: string;
    readonly tone: "info" | "approval" | "error";
    readonly payload: unknown;
  }) =>
    Effect.gen(function* () {
      const [commandUuid, eventUuid, createdAt] = yield* Effect.all([uuid, uuid, nowIso]);
      return yield* dispatcher.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`plan-review:activity:${commandUuid}`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(`plan-review:${eventUuid}`),
          tone: input.tone,
          kind: "plan-review",
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(Effect.ignore);

  /**
   * Close the proposed-plan records a decided review came from.
   *
   * `hasActionableProposedPlan` — the projection behind the violet "Plan Ready"
   * row, the plan badge and the composer's follow-up banner — is true while the
   * newest proposed plan has no `implementedAt`. Approving or discarding a
   * review ends the planning phase, but nothing used to write that back, so a
   * thread kept advertising a decision that had already been made: the row
   * returned to Plan Ready the moment the implementation turn settled.
   *
   * Feedback is deliberately not closed here. The lineage stays live until the
   * agent answers it, and while that turn runs the row reads as working; the
   * revision then becomes the plan that is genuinely waiting.
   *
   * Failure is swallowed: a decision that reached the agent must not be undone
   * by a projection write.
   */
  const markPlansImplemented = (input: {
    readonly threadId: ThreadId;
    readonly documentId: string;
    readonly implementationThreadId: ThreadId | null;
  }) =>
    Effect.gen(function* () {
      const versions = yield* repository.listVersions(input.documentId);
      const sourcePlanIds = new Set(
        versions.flatMap((version) =>
          version.sourcePlanId === null ? [] : [version.sourcePlanId],
        ),
      );
      if (sourcePlanIds.size === 0) return;

      const threadOption = yield* query.getThreadDetailById(input.threadId);
      if (Option.isNone(threadOption)) return;
      const open = threadOption.value.proposedPlans.filter(
        (plan) => plan.implementedAt === null && sourcePlanIds.has(plan.id),
      );
      if (open.length === 0) return;

      const implementedAt = yield* nowIso;
      yield* Effect.forEach(
        open,
        (plan) =>
          Effect.gen(function* () {
            const commandUuid = yield* uuid;
            yield* dispatcher.dispatch({
              type: "thread.proposed-plan.upsert",
              commandId: CommandId.make(`plan-review:implemented:${commandUuid}`),
              threadId: input.threadId,
              proposedPlan: {
                ...plan,
                implementedAt,
                implementationThreadId: input.implementationThreadId,
                updatedAt: implementedAt,
              },
              createdAt: implementedAt,
            });
          }),
        { discard: true },
      );
    }).pipe(Effect.ignore);

  const capturePlan: PlanReviewService["Service"]["capturePlan"] = (input) =>
    Effect.gen(function* () {
      // A plan id we have already captured means this is a redelivery, not a
      // new revision — return the existing document untouched.
      const existingForPlan = yield* repository
        .findDocumentBySourcePlanId(input.planId)
        .pipe(asInvariant("capturePlan.findBySourcePlan"));
      if (Option.isSome(existingForPlan)) {
        // Reconciliation and redelivery both land here, which makes it the one
        // place that sees a plan whose review already ended while its
        // proposed-plan record is still open — decisions taken before this
        // write-back existed, or an approval whose turn never started. Heal it.
        const decided = existingForPlan.value;
        if (decided.status === "approved" || decided.status === "discarded") {
          yield* markPlansImplemented({
            threadId: decided.threadId,
            documentId: decided.documentId,
            implementationThreadId: decided.status === "approved" ? decided.threadId : null,
          });
        }
        return decided;
      }

      // An open document on the same thread is the lineage this plan revises.
      // A lineage awaiting a revision is still the lineage this plan belongs
      // to. Only approved and discarded documents are closed for good — without
      // "changes-requested" here, the agent's answer to feedback would start a
      // brand-new history and orphan the comments that asked for it.
      const threadDocuments = yield* repository
        .listDocumentsForThread(input.threadId)
        .pipe(asInvariant("capturePlan.listForThread"));
      const openDocument = threadDocuments.find(
        (document) => document.status === "open" || document.status === "changes-requested",
      );

      const createdAt = yield* nowIso;

      if (openDocument === undefined) {
        const documentUuid = yield* uuid;
        const documentId = `plan-doc:${documentUuid}`;
        const versionUuid = yield* uuid;

        const document: PlanDocumentRecord = {
          documentId,
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          currentRevision: 1,
          status: "open",
          // Providers put an HTML plan in the same field as markdown, so the
          // renderer is decided once at capture and remembered.
          format: detectPlanFormat(input.planMarkdown),
          createdByUserId: input.authorUserId,
          createdAt,
          updatedAt: createdAt,
        };

        yield* repository.upsertDocument(document).pipe(asInvariant("capturePlan.upsertDocument"));
        yield* repository
          .appendVersion({
            versionId: `plan-ver:${versionUuid}`,
            documentId,
            revision: 1,
            authorKind: "agent",
            authorUserId: null,
            origin: "agent-proposed",
            contentMarkdown: input.planMarkdown,
            contentValueJson: null,
            sourcePlanId: input.planId,
            summary: null,
            createdAt,
          })
          .pipe(asInvariant("capturePlan.appendVersion"));

        return document;
      }

      // Revision of an existing lineage: skip when the content is unchanged so
      // a redelivered projection event cannot inflate the history.
      const latest = yield* repository
        .getLatestVersion(openDocument.documentId)
        .pipe(asInvariant("capturePlan.getLatestVersion"));
      if (
        Option.isSome(latest) &&
        latest.value.contentMarkdown.trim() === input.planMarkdown.trim()
      ) {
        return openDocument;
      }

      const nextRevision = openDocument.currentRevision + 1;
      const versionUuid = yield* uuid;
      yield* repository
        .appendVersion({
          versionId: `plan-ver:${versionUuid}`,
          documentId: openDocument.documentId,
          revision: nextRevision,
          authorKind: "agent",
          authorUserId: null,
          origin: "agent-revision",
          contentMarkdown: input.planMarkdown,
          contentValueJson: null,
          sourcePlanId: input.planId,
          summary: null,
          createdAt,
        })
        .pipe(asInvariant("capturePlan.appendRevision"));

      const updated: PlanDocumentRecord = {
        ...openDocument,
        title: input.title,
        currentRevision: nextRevision,
        format: detectPlanFormat(input.planMarkdown),
        // The revision answers the feedback, so the review is live again.
        status: "open",
        updatedAt: createdAt,
      };
      yield* repository.upsertDocument(updated).pipe(asInvariant("capturePlan.updateDocument"));

      // A new agent revision invalidates the human draft it was based on.
      yield* repository
        .clearDraft(openDocument.documentId)
        .pipe(asInvariant("capturePlan.clearDraft"));

      yield* announce(openDocument.documentId);
      return updated;
    });

  const getReview: PlanReviewService["Service"]["getReview"] = (documentId) =>
    Effect.gen(function* () {
      const document = yield* requireDocument(documentId);
      const [versions, draftOption, discussions, comments] = yield* Effect.all([
        repository.listVersions(documentId).pipe(asInvariant("getReview.versions")),
        repository.getDraft(documentId).pipe(asInvariant("getReview.draft")),
        repository.listDiscussions(documentId).pipe(asInvariant("getReview.discussions")),
        repository.listDiscussionComments(documentId).pipe(asInvariant("getReview.comments")),
      ]);

      return {
        document,
        versions,
        draft: Option.isSome(draftOption)
          ? {
              contentValueJson: draftOption.value.contentValueJson,
              baseVersionId: draftOption.value.baseVersionId,
              revisionToken: draftOption.value.revisionToken,
              updatedByUserId: draftOption.value.updatedByUserId,
              updatedAt: draftOption.value.updatedAt,
            }
          : null,
        discussions,
        comments,
      } satisfies PlanReviewSnapshot;
    });

  /**
   * Lists a thread's plan documents, capturing the thread's reviewable plan
   * first if nothing covers it yet.
   *
   * Startup reconciliation only walks the newest plan per active thread, so
   * plans that predate the feature — or that it skipped — would otherwise have
   * no document, and the UI would offer no way in. Capturing here means the
   * entry point appears wherever a reviewable plan exists. `capturePlan`
   * dedupes on the source plan id, so repeating this is a no-op.
   */
  const listForThread: PlanReviewService["Service"]["listForThread"] = (threadId) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .listDocumentsForThread(threadId)
        .pipe(asInvariant("listForThread"));
      if (
        existing.some(
          (document) => document.status === "open" || document.status === "changes-requested",
        )
      ) {
        return existing;
      }

      const threadOption = yield* query
        .getThreadDetailById(threadId)
        .pipe(asInvariant("listForThread.getThread"));
      if (Option.isNone(threadOption)) return existing;
      const thread = threadOption.value;

      const reviewable = [...thread.proposedPlans]
        .filter((plan) => plan.implementedAt === null)
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .at(-1);
      if (reviewable === undefined) return existing;

      const planMarkdown = withoutLegacyReviewMarker(reviewable.planMarkdown).trim();
      if (planMarkdown.length === 0) return existing;

      yield* capturePlan({
        threadId,
        projectId: thread.projectId,
        planId: reviewable.id,
        planMarkdown,
        title: derivePlanTitle(planMarkdown),
        authorUserId: null,
      });

      return yield* repository
        .listDocumentsForThread(threadId)
        .pipe(asInvariant("listForThread.reload"));
    });

  const saveDraft: PlanReviewService["Service"]["saveDraft"] = (input) =>
    Effect.gen(function* () {
      const document = yield* requireDocument(input.documentId);
      if (document.status !== "open") {
        return yield* new PlanReviewInvariantError({
          operation: "saveDraft",
          detail: `This review is ${document.status} and can no longer be edited.`,
        });
      }
      const latest = yield* repository
        .getLatestVersion(document.documentId)
        .pipe(asInvariant("saveDraft.getLatestVersion"));
      if (Option.isNone(latest)) {
        return yield* new PlanReviewInvariantError({
          operation: "saveDraft",
          detail: "The plan has no versions yet.",
        });
      }

      const [tokenUuid, updatedAt] = yield* Effect.all([uuid, nowIso]);
      const nextRevisionToken = `draft:${tokenUuid}`;

      yield* repository
        .saveDraft({
          documentId: document.documentId,
          baseVersionId: latest.value.versionId,
          contentValueJson: input.contentValueJson,
          updatedByUserId: input.actorUserId,
          updatedAt,
          expectedRevisionToken: input.expectedRevisionToken,
          nextRevisionToken,
        })
        .pipe(asInvariant("saveDraft"));

      // Deliberately not announced: a draft is one reviewer's working copy, and
      // broadcasting it would push the whole version history on every keystroke.
      return { revisionToken: nextRevisionToken };
    });

  const cutVersion: PlanReviewService["Service"]["cutVersion"] = (input) =>
    Effect.gen(function* () {
      const document = yield* requireDocument(input.documentId);
      const latest = yield* repository
        .getLatestVersion(document.documentId)
        .pipe(asInvariant("cutVersion.getLatestVersion"));

      if (
        Option.isSome(latest) &&
        latest.value.contentMarkdown.trim() === input.contentMarkdown.trim()
      ) {
        return latest.value;
      }

      const [versionUuid, createdAt] = yield* Effect.all([uuid, nowIso]);
      const revision = document.currentRevision + 1;
      const version: PlanVersionRecord = {
        versionId: `plan-ver:${versionUuid}`,
        documentId: document.documentId,
        revision,
        authorKind: "user",
        authorUserId: input.actorUserId,
        origin: "human-edit",
        contentMarkdown: input.contentMarkdown,
        contentValueJson: input.contentValueJson,
        sourcePlanId: null,
        summary: input.summary,
        createdAt,
      };

      yield* repository.appendVersion(version).pipe(asInvariant("cutVersion.appendVersion"));
      yield* repository
        .upsertDocument({ ...document, currentRevision: revision, updatedAt: createdAt })
        .pipe(asInvariant("cutVersion.updateDocument"));

      yield* announce(document.documentId);
      return version;
    });

  const upsertDiscussion: PlanReviewService["Service"]["upsertDiscussion"] = (input) =>
    Effect.gen(function* () {
      const document = yield* requireDocument(input.documentId);
      const latest = yield* repository
        .getLatestVersion(document.documentId)
        .pipe(asInvariant("upsertDiscussion.getLatestVersion"));
      if (Option.isNone(latest)) {
        return yield* new PlanReviewInvariantError({
          operation: "upsertDiscussion",
          detail: "The plan has no versions yet.",
        });
      }

      const [commentUuid, createdAt] = yield* Effect.all([uuid, nowIso]);
      yield* repository
        .upsertDiscussion({
          discussionId: input.discussionId,
          documentId: document.documentId,
          anchorVersionId: latest.value.versionId,
          quotedText: input.quotedText,
          createdByUserId: input.actorUserId,
          createdAt,
        })
        .pipe(asInvariant("upsertDiscussion"));

      yield* repository
        .addDiscussionComment({
          commentId: `plan-comment:${commentUuid}`,
          discussionId: input.discussionId,
          documentId: document.documentId,
          authorUserId: input.actorUserId,
          bodyMarkdown: input.bodyMarkdown,
          createdAt,
        })
        .pipe(asInvariant("upsertDiscussion.addComment"));

      yield* announce(document.documentId);
    });

  const resolveDiscussion: PlanReviewService["Service"]["resolveDiscussion"] = (input) =>
    Effect.gen(function* () {
      yield* requireDocument(input.documentId);
      const resolvedAt = yield* nowIso;
      yield* repository
        .resolveDiscussion({
          discussionId: input.discussionId,
          documentId: input.documentId,
          isResolved: input.isResolved,
          resolvedByUserId: input.isResolved ? input.actorUserId : null,
          resolvedAt: input.isResolved ? resolvedAt : null,
        })
        .pipe(asInvariant("resolveDiscussion"));

      yield* announce(input.documentId);
    });

  const getVersionDiff: PlanReviewService["Service"]["getVersionDiff"] = (input) =>
    Effect.gen(function* () {
      const document = yield* requireDocument(input.documentId);
      const [fromOption, toOption] = yield* Effect.all([
        repository
          .getVersion({ documentId: document.documentId, versionId: input.fromVersionId })
          .pipe(asInvariant("getVersionDiff.from")),
        repository
          .getVersion({ documentId: document.documentId, versionId: input.toVersionId })
          .pipe(asInvariant("getVersionDiff.to")),
      ]);
      if (Option.isNone(fromOption) || Option.isNone(toOption)) {
        return yield* new PlanReviewInvariantError({
          operation: "getVersionDiff",
          detail: "One of the requested versions does not exist.",
        });
      }

      const { diff } = buildUnifiedDiff(
        fromOption.value.contentMarkdown,
        toOption.value.contentMarkdown,
      );
      return { diff: toRenderableFileDiff(`${document.title}.md`, diff) };
    });

  /** Builds the anchored comment payloads the prompt embeds. */
  const buildAnchoredComments = (
    baseMarkdown: string,
    discussions: ReadonlyArray<PlanDiscussionRecord>,
    comments: ReadonlyArray<PlanDiscussionCommentRecord>,
    resolveLabel: (userId: UserId | null) => string | null,
  ): {
    readonly comments: ReadonlyArray<PlanReviewAnchoredComment>;
    readonly discussionIds: ReadonlyArray<string>;
  } => {
    const byDiscussion = new Map<string, PlanDiscussionCommentRecord[]>();
    for (const comment of comments) {
      const bucket = byDiscussion.get(comment.discussionId);
      if (bucket) bucket.push(comment);
      else byDiscussion.set(comment.discussionId, [comment]);
    }

    const anchored: PlanReviewAnchoredComment[] = [];
    const discussionIds: string[] = [];
    for (const discussion of discussions) {
      if (discussion.isResolved) continue;
      const bucket = byDiscussion.get(discussion.discussionId) ?? [];
      const body = bucket.map((comment) => comment.bodyMarkdown.trim()).join("\n\n");
      if (body.length === 0) continue;

      // A quote we cannot find still carries its text, just without a range.
      const located = locateQuotedLineRange(baseMarkdown, discussion.quotedText);
      anchored.push({
        startIndex: located?.startIndex ?? null,
        endIndex: located?.endIndex ?? null,
        quotedText: discussion.quotedText,
        body,
        authorLabel: resolveLabel(bucket[0]?.authorUserId ?? discussion.createdByUserId),
      });
      discussionIds.push(discussion.discussionId);
    }
    return { comments: anchored, discussionIds };
  };

  const submit: PlanReviewService["Service"]["submit"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* getReview(input.documentId);
      const document = snapshot.document;

      // Two tabs, or a replayed request, must not start implementation twice.
      if (document.status !== "open") {
        return yield* new PlanReviewInvariantError({
          operation: "submit",
          detail: `This review was already ${document.status}.`,
        });
      }

      const latestVersion = snapshot.versions.at(-1);
      if (latestVersion === undefined) {
        return yield* new PlanReviewInvariantError({
          operation: "submit",
          detail: "The plan has no versions yet.",
        });
      }

      const resolveLabel = (userId: UserId | null) =>
        userId === null ? input.actorLabel : userId === input.actorUserId ? input.actorLabel : null;

      // Reviewer edits become a real version before anything is sent, so the
      // history always explains what the agent was told.
      const agentBaseline =
        snapshot.versions.toReversed().find((version) => version.authorKind === "agent") ??
        latestVersion;

      let approvedVersion = latestVersion;
      if (
        input.editedMarkdown !== null &&
        input.editedMarkdown.trim() !== latestVersion.contentMarkdown.trim()
      ) {
        approvedVersion = yield* cutVersion({
          documentId: document.documentId,
          contentMarkdown: input.editedMarkdown,
          contentValueJson: null,
          summary: input.decision === "approved" ? "Edited before approval" : "Reviewer edit",
          actorUserId: input.actorUserId,
        });
      }

      const editResult = buildUnifiedDiff(
        agentBaseline.contentMarkdown,
        approvedVersion.contentMarkdown,
      );

      if (input.decision === "discarded") {
        const discardedAt = yield* nowIso;
        yield* repository
          .setDocumentStatus({
            documentId: document.documentId,
            status: "discarded",
            updatedAt: discardedAt,
          })
          .pipe(asInvariant("submit.discard"));
        yield* markPlansImplemented({
          threadId: document.threadId,
          documentId: document.documentId,
          implementationThreadId: null,
        });
        yield* appendActivity({
          threadId: document.threadId,
          summary: "Plan review was discarded.",
          tone: "error",
          payload: { documentId: document.documentId, decision: "discarded" },
        });
        yield* announce(document.documentId);
        return {
          documentId: document.documentId,
          status: "discarded",
          prompt: null,
          turnStarted: false,
          resentPlan: false,
        } satisfies SubmitReviewResult;
      }

      const threadOption = yield* query
        .getThreadDetailById(document.threadId)
        .pipe(asInvariant("submit.getThread"));
      if (Option.isNone(threadOption)) {
        return yield* new PlanReviewInvariantError({
          operation: "submit",
          detail: `Thread ${document.threadId} was not found.`,
        });
      }
      const thread = threadOption.value;

      let prompt: string;
      let resentPlan = false;
      const anchored = buildAnchoredComments(
        agentBaseline.contentMarkdown,
        snapshot.discussions,
        snapshot.comments,
        resolveLabel,
      );
      const sentDiscussionIds = anchored.discussionIds;
      const hasReviewerEdits = editResult.diff.trim().length > 0;

      if (input.decision === "approved") {
        const latestCompactionAt =
          [...thread.activities]
            .filter((activity) => activity.kind === "context-compaction")
            .map((activity) => activity.createdAt)
            .sort()
            .at(-1) ?? null;

        const resend = decidePlanResend({
          latestCompactionAt,
          planCreatedAt: agentBaseline.createdAt,
          planThreadId: document.threadId,
          targetThreadId: document.threadId,
          providerSessionStatus: thread.session?.status ?? null,
        });
        resentPlan = resend.shouldResend;

        prompt = buildPlanReviewApprovalPrompt({
          documentId: document.documentId,
          planTitle: document.title,
          notes: input.globalComment,
          comments: anchored.comments,
          fullPlanMarkdown:
            hasReviewerEdits || resend.shouldResend ? approvedVersion.contentMarkdown : null,
          fullPlanReason: hasReviewerEdits ? null : resend.reason,
          wasEdited: hasReviewerEdits,
        });
      } else {
        prompt = buildPlanReviewFeedbackPrompt({
          documentId: document.documentId,
          planTitle: document.title,
          globalComment: input.globalComment,
          comments: anchored.comments,
          fullDocument: hasReviewerEdits ? approvedVersion.contentMarkdown : null,
        });
      }

      const [commandUuid, messageUuid, modeUuid, createdAt] = yield* Effect.all([
        uuid,
        uuid,
        uuid,
        nowIso,
      ]);

      // The reviewer is the sender of this turn. A sender-less turn resolves a
      // different session identity than the reviewer's own messages, which
      // restarts the provider process exactly as the approval is delivered.
      const dispatchOptions = { actorUserId: input.actorUserId };

      // Only approval may leave Plan mode; feedback keeps the thread planning.
      if (input.decision === "approved") {
        const modeCommand: OrchestrationCommand = {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`plan-review:mode:${modeUuid}`),
          threadId: document.threadId,
          interactionMode: "default",
          createdAt,
        };
        yield* dispatcher
          .dispatch(modeCommand, dispatchOptions)
          .pipe(asInvariant("submit.setMode"));
      }

      yield* dispatcher
        .dispatch(
          {
            type: "thread.turn.start",
            commandId: CommandId.make(`plan-review:turn:${commandUuid}`),
            threadId: document.threadId,
            message: {
              messageId: MessageId.make(`plan-review:${messageUuid}`),
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: input.decision === "approved" ? "default" : "plan",
            ...(input.decision === "approved" && approvedVersion.sourcePlanId !== null
              ? {
                  sourceProposedPlan: {
                    threadId: document.threadId,
                    planId: approvedVersion.sourcePlanId as OrchestrationProposedPlanId,
                  },
                }
              : input.decision === "approved" && agentBaseline.sourcePlanId !== null
                ? {
                    sourceProposedPlan: {
                      threadId: document.threadId,
                      planId: agentBaseline.sourcePlanId as OrchestrationProposedPlanId,
                    },
                  }
                : {}),
            createdAt,
          },
          dispatchOptions,
        )
        .pipe(asInvariant("submit.startTurn"));

      const status: PlanDocumentStatus =
        input.decision === "approved" ? "approved" : "changes-requested";
      yield* repository
        .setDocumentStatus({
          documentId: document.documentId,
          status,
          updatedAt: createdAt,
        })
        .pipe(asInvariant("submit.setStatus"));
      yield* repository.clearDraft(document.documentId).pipe(asInvariant("submit.clearDraft"));

      // Implementation starts in this thread, so the plan is no longer waiting
      // on anyone. Upstream only closes a plan when a *different* thread picks
      // it up, which never happens on this path.
      if (input.decision === "approved") {
        yield* markPlansImplemented({
          threadId: document.threadId,
          documentId: document.documentId,
          implementationThreadId: document.threadId,
        });
      }

      // Anything already handed to the agent is spent. This applies to an
      // approval too: implementation comments must not remain falsely open in
      // the resolved review history.
      if (sentDiscussionIds.length > 0) {
        yield* Effect.forEach(
          sentDiscussionIds,
          (discussionId) =>
            repository
              .resolveDiscussion({
                discussionId,
                documentId: document.documentId,
                isResolved: true,
                resolvedByUserId: input.actorUserId,
                resolvedAt: createdAt,
              })
              .pipe(asInvariant("submit.consumeDiscussions")),
          { discard: true },
        );
      }

      yield* announce(document.documentId);

      yield* appendActivity({
        threadId: document.threadId,
        summary:
          input.decision === "approved"
            ? "Plan approved; implementation was started."
            : "Plan feedback was sent to the planning agent.",
        tone: input.decision === "approved" ? "approval" : "info",
        payload: {
          documentId: document.documentId,
          decision: input.decision,
          revision: approvedVersion.revision,
          resentPlan,
        },
      });

      return {
        documentId: document.documentId,
        status,
        prompt,
        turnStarted: true,
        resentPlan,
      } satisfies SubmitReviewResult;
    });

  const watch: PlanReviewService["Service"]["watch"] = (documentId) =>
    Stream.concat(
      Stream.fromEffect(getReview(documentId)),
      Stream.fromPubSub(changes).pipe(
        Stream.filter((changed) => changed === documentId),
        Stream.mapEffect(() => getReview(documentId)),
      ),
    );

  return PlanReviewService.of({
    capturePlan,
    getReview,
    listForThread,
    saveDraft,
    cutVersion,
    upsertDiscussion,
    resolveDiscussion,
    getVersionDiff,
    submit,
    watch,
  });
});

export const layer = Layer.effect(PlanReviewService, make);
