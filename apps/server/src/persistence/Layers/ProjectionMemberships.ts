import { ProjectId, ThreadId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionMembershipRepository,
  ProjectionProjectMember,
  ProjectionThreadMember,
  RemoveProjectMemberInput,
  RemoveThreadMemberInput,
  type ProjectionMembershipRepositoryShape,
} from "../Services/ProjectionMemberships.ts";

const ThreadIdRow = Schema.Struct({ threadId: ThreadId });
const ProjectIdRow = Schema.Struct({ projectId: ProjectId });
const UserIdRow = Schema.Struct({ userId: UserId });

const ThreadIdRequest = Schema.Struct({ threadId: ThreadId });
const ProjectIdRequest = Schema.Struct({ projectId: ProjectId });
const UserIdRequest = Schema.Struct({ userId: UserId });

const makeProjectionMembershipRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertThreadMemberRow = SqlSchema.void({
    Request: ProjectionThreadMember,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_members (
          thread_id,
          user_id,
          added_by_user_id,
          added_at
        )
        VALUES (
          ${row.threadId},
          ${row.userId},
          ${row.addedByUserId},
          ${row.addedAt}
        )
        ON CONFLICT (thread_id, user_id)
        DO UPDATE SET
          added_by_user_id = excluded.added_by_user_id,
          added_at = excluded.added_at
      `,
  });

  const removeThreadMemberRow = SqlSchema.void({
    Request: RemoveThreadMemberInput,
    execute: ({ threadId, userId }) =>
      sql`
        DELETE FROM projection_thread_members
        WHERE thread_id = ${threadId} AND user_id = ${userId}
      `,
  });

  const upsertProjectMemberRow = SqlSchema.void({
    Request: ProjectionProjectMember,
    execute: (row) =>
      sql`
        INSERT INTO projection_project_members (
          project_id,
          user_id,
          added_by_user_id,
          added_at
        )
        VALUES (
          ${row.projectId},
          ${row.userId},
          ${row.addedByUserId},
          ${row.addedAt}
        )
        ON CONFLICT (project_id, user_id)
        DO UPDATE SET
          added_by_user_id = excluded.added_by_user_id,
          added_at = excluded.added_at
      `,
  });

  const removeProjectMemberRow = SqlSchema.void({
    Request: RemoveProjectMemberInput,
    execute: ({ projectId, userId }) =>
      sql`
        DELETE FROM projection_project_members
        WHERE project_id = ${projectId} AND user_id = ${userId}
      `,
  });

  const listThreadMemberIdRows = SqlSchema.findAll({
    Request: ThreadIdRequest,
    Result: UserIdRow,
    execute: ({ threadId }) =>
      sql`
        SELECT user_id AS "userId"
        FROM projection_thread_members
        WHERE thread_id = ${threadId}
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listProjectMemberIdRows = SqlSchema.findAll({
    Request: ProjectIdRequest,
    Result: UserIdRow,
    execute: ({ projectId }) =>
      sql`
        SELECT user_id AS "userId"
        FROM projection_project_members
        WHERE project_id = ${projectId}
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listAllThreadMemberRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMember,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          user_id AS "userId",
          added_by_user_id AS "addedByUserId",
          added_at AS "addedAt"
        FROM projection_thread_members
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listAllProjectMemberRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectMember,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          user_id AS "userId",
          added_by_user_id AS "addedByUserId",
          added_at AS "addedAt"
        FROM projection_project_members
        ORDER BY added_at ASC, user_id ASC
      `,
  });

  const listVisibleThreadIdRows = SqlSchema.findAll({
    Request: UserIdRequest,
    Result: ThreadIdRow,
    execute: ({ userId }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM projection_threads
        WHERE owner_user_id = ${userId}
        UNION
        SELECT thread_id AS "threadId"
        FROM projection_thread_members
        WHERE user_id = ${userId}
      `,
  });

  const listVisibleProjectIdRows = SqlSchema.findAll({
    Request: UserIdRequest,
    Result: ProjectIdRow,
    execute: ({ userId }) =>
      sql`
        SELECT project_id AS "projectId"
        FROM projection_projects
        WHERE owner_user_id = ${userId}
        UNION
        SELECT project_id AS "projectId"
        FROM projection_project_members
        WHERE user_id = ${userId}
      `,
  });

  const upsertThreadMember: ProjectionMembershipRepositoryShape["upsertThreadMember"] = (row) =>
    upsertThreadMemberRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.upsertThreadMember")),
    );

  const removeThreadMember: ProjectionMembershipRepositoryShape["removeThreadMember"] = (input) =>
    removeThreadMemberRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.removeThreadMember")),
    );

  const upsertProjectMember: ProjectionMembershipRepositoryShape["upsertProjectMember"] = (row) =>
    upsertProjectMemberRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.upsertProjectMember")),
    );

  const removeProjectMember: ProjectionMembershipRepositoryShape["removeProjectMember"] = (input) =>
    removeProjectMemberRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.removeProjectMember")),
    );

  const listThreadMemberIds: ProjectionMembershipRepositoryShape["listThreadMemberIds"] = (
    threadId,
  ) =>
    listThreadMemberIdRows({ threadId }).pipe(
      Effect.map((rows) => rows.map((row) => row.userId)),
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.listThreadMemberIds")),
    );

  const listProjectMemberIds: ProjectionMembershipRepositoryShape["listProjectMemberIds"] = (
    projectId,
  ) =>
    listProjectMemberIdRows({ projectId }).pipe(
      Effect.map((rows) => rows.map((row) => row.userId)),
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.listProjectMemberIds")),
    );

  const listAllThreadMembers: ProjectionMembershipRepositoryShape["listAllThreadMembers"] = () =>
    listAllThreadMemberRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.listAllThreadMembers")),
    );

  const listAllProjectMembers: ProjectionMembershipRepositoryShape["listAllProjectMembers"] = () =>
    listAllProjectMemberRows().pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionMembershipRepository.listAllProjectMembers"),
      ),
    );

  const listVisibleThreadIds: ProjectionMembershipRepositoryShape["listVisibleThreadIds"] = (
    userId,
  ) =>
    listVisibleThreadIdRows({ userId }).pipe(
      Effect.map((rows) => rows.map((row) => row.threadId)),
      Effect.mapError(toPersistenceSqlError("ProjectionMembershipRepository.listVisibleThreadIds")),
    );

  const listVisibleProjectIds: ProjectionMembershipRepositoryShape["listVisibleProjectIds"] = (
    userId,
  ) =>
    listVisibleProjectIdRows({ userId }).pipe(
      Effect.map((rows) => rows.map((row) => row.projectId)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionMembershipRepository.listVisibleProjectIds"),
      ),
    );

  return {
    upsertThreadMember,
    removeThreadMember,
    upsertProjectMember,
    removeProjectMember,
    listThreadMemberIds,
    listProjectMemberIds,
    listAllThreadMembers,
    listAllProjectMembers,
    listVisibleThreadIds,
    listVisibleProjectIds,
  } satisfies ProjectionMembershipRepositoryShape;
});

export const ProjectionMembershipRepositoryLive = Layer.effect(
  ProjectionMembershipRepository,
  makeProjectionMembershipRepository,
);
