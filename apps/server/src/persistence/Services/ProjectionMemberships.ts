/**
 * ProjectionMembershipRepository - Projection repository for thread/project
 * membership (team mode).
 *
 * Owns the `projection_thread_members` / `projection_project_members` join
 * tables plus the derived per-user visibility queries used by access control.
 * The creator (owner) is never stored as a member row — ownership lives in the
 * `owner_user_id` column on the thread/project tables and is folded into the
 * visibility queries here.
 *
 * @module ProjectionMembershipRepository
 */
import { IsoDateTime, ProjectId, ThreadId, UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMember = Schema.Struct({
  threadId: ThreadId,
  userId: UserId,
  addedByUserId: Schema.NullOr(UserId),
  addedAt: IsoDateTime,
});
export type ProjectionThreadMember = typeof ProjectionThreadMember.Type;

export const ProjectionProjectMember = Schema.Struct({
  projectId: ProjectId,
  userId: UserId,
  addedByUserId: Schema.NullOr(UserId),
  addedAt: IsoDateTime,
});
export type ProjectionProjectMember = typeof ProjectionProjectMember.Type;

export const RemoveThreadMemberInput = Schema.Struct({
  threadId: ThreadId,
  userId: UserId,
});
export type RemoveThreadMemberInput = typeof RemoveThreadMemberInput.Type;

export const RemoveProjectMemberInput = Schema.Struct({
  projectId: ProjectId,
  userId: UserId,
});
export type RemoveProjectMemberInput = typeof RemoveProjectMemberInput.Type;

/**
 * ProjectionMembershipRepositoryShape - Service API for membership persistence.
 */
export interface ProjectionMembershipRepositoryShape {
  readonly upsertThreadMember: (
    row: ProjectionThreadMember,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeThreadMember: (
    input: RemoveThreadMemberInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly upsertProjectMember: (
    row: ProjectionProjectMember,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeProjectMember: (
    input: RemoveProjectMemberInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** T3-CUSTOM(expbkt3): Explicitly tagged users; a creator can also be the owner. */
  readonly listThreadMemberIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<UserId>, ProjectionRepositoryError>;
  /** Member user ids for a single project (excludes the owner). */
  readonly listProjectMemberIds: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<UserId>, ProjectionRepositoryError>;

  /** All thread member rows — used to bulk-hydrate snapshots. */
  readonly listAllThreadMembers: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadMember>,
    ProjectionRepositoryError
  >;
  /** All project member rows — used to bulk-hydrate snapshots. */
  readonly listAllProjectMembers: () => Effect.Effect<
    ReadonlyArray<ProjectionProjectMember>,
    ProjectionRepositoryError
  >;

  /**
   * Thread ids the user can see directly: threads they own OR are tagged into.
   * (Project-tag visibility is composed on top of this by the access layer.)
   */
  readonly listVisibleThreadIds: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;
  /**
   * Project ids the user can see directly: projects they own OR are tagged into.
   */
  readonly listVisibleProjectIds: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<ProjectId>, ProjectionRepositoryError>;
}

/**
 * ProjectionMembershipRepository - Service tag for membership persistence.
 */
export class ProjectionMembershipRepository extends Context.Service<
  ProjectionMembershipRepository,
  ProjectionMembershipRepositoryShape
>()("t3/persistence/Services/ProjectionMemberships/ProjectionMembershipRepository") {}
