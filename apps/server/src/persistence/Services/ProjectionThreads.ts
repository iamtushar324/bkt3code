/**
 * ProjectionThreadRepository - Projection repository interface for threads.
 *
 * Owns persistence operations for projected thread records in the
 * orchestration read model.
 *
 * @module ProjectionThreadRepository
 */
import {
  CommandId,
  // T3-CUSTOM(expbkt3): a parent session may live on another environment.
  EnvironmentId,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  SourceControlProfileId,
  ThreadLinkedPullRequest,
  ThreadTitleState,
  ThreadId,
  ThreadPriority,
  TurnId,
  UserId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThread = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  titleState: Schema.optional(Schema.NullOr(ThreadTitleState)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  // T3-CUSTOM(expbkt3): source-control identity — which git profile a thread's commits are attributed to.
  sourceControlProfileId: Schema.NullOr(SourceControlProfileId),
  linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  branchPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
  latestTurnId: Schema.NullOr(TurnId),
  // T3-CUSTOM(expbkt3): thread ownership — the environment user this thread belongs to.
  ownerUserId: Schema.NullOr(UserId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  settledOverride: Schema.NullOr(Schema.Literals(["settled", "active"])),
  settledAt: Schema.NullOr(IsoDateTime),
  unsettledAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  snoozedAt: Schema.NullOr(IsoDateTime),
  // T3-CUSTOM(expbkt3): session priority (P0..P4 as 0..4, null = unset).
  priority: Schema.NullOr(ThreadPriority),
  // T3-CUSTOM(expbkt3): custom sidebar group label (null = ungrouped).
  customGroup: Schema.optional(Schema.NullOr(Schema.String)),
  // T3-CUSTOM(expbkt3): durable manual Linear issue URL.
  linearIssueUrl: Schema.optional(Schema.NullOr(Schema.String)),
  // T3-CUSTOM(expbkt3): durable Mattermost conversation permalink.
  mattermostThreadUrl: Schema.optional(Schema.NullOr(Schema.String)),
  // T3-CUSTOM(expbkt3): session lineage; null means this is a root session.
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  // T3-CUSTOM(expbkt3): the environment the parent id belongs to. Null means
  // this thread's own, so every pre-existing row keeps its meaning.
  parentEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  pinnedAt: Schema.NullOr(IsoDateTime),
  pinOrderKey: Schema.optional(Schema.NullOr(Schema.String)),
  activeOrderKey: Schema.optional(Schema.NullOr(Schema.String)),
  autoSettleDisabledAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  titleRegenerationRequestId: Schema.optional(Schema.NullOr(CommandId)),
  titleRegenerationStartedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  latestUserMessageAt: Schema.NullOr(IsoDateTime),
  pendingApprovalCount: NonNegativeInt,
  pendingUserInputCount: NonNegativeInt,
  // T3-CUSTOM(expbkt3): visible async questions never set the blocking count.
  pendingAsyncUserInputCount: Schema.optional(NonNegativeInt),
  hasActionableProposedPlan: NonNegativeInt,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThread = typeof ProjectionThread.Type;

export const GetProjectionThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadInput = typeof GetProjectionThreadInput.Type;

/**
 * ProjectionThreadRepositoryShape - Service API for projected thread records.
 */
export interface ProjectionThreadRepositoryShape {
  /**
   * Insert or replace a projected thread row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (thread: ProjectionThread) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread row by id.
   */
  readonly getById: (
    input: GetProjectionThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThread>, ProjectionRepositoryError>;

  // T3-CUSTOM(expbkt3): every thread the session-history backfill must cover.
  // Soft-deleted rows are included deliberately: their messages are still in
  // the projection, and the archive is the only record that survives them.
  readonly listArchivedOrDeleted: () => Effect.Effect<
    ReadonlyArray<ProjectionThread>,
    ProjectionRepositoryError
  >;
}

/**
 * ProjectionThreadRepository - Service tag for thread projection persistence.
 */
export class ProjectionThreadRepository extends Context.Service<
  ProjectionThreadRepository,
  ProjectionThreadRepositoryShape
>()("t3/persistence/Services/ProjectionThreads/ProjectionThreadRepository") {}
