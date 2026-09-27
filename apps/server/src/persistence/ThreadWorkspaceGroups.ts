/**
 * T3-CUSTOM(expbkt3): the worktree a parent session shares across its children
 * in one repository.
 *
 * `claim` is the whole point of this module: it is insert-or-read, so the
 * winner of a parallel fan-out is decided by SQLite rather than by which fiber
 * observed the projection first. Every caller gets the same row back, and the
 * one whose own identity is returned is the child that must actually create the
 * worktree.
 */
import { ProjectId, ThreadId } from "@t3tools/contracts";
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

export type ThreadWorkspaceGroupRepositoryError = ProjectionRepositoryError;

export const ThreadWorkspaceGroup = Schema.Struct({
  ownerThreadId: ThreadId,
  projectId: ProjectId,
  branch: Schema.String,
  worktreePath: Schema.String,
  /** The worktree exists on disk, so a joining sibling can use it as it is. */
  isReady: Schema.Boolean,
});
export type ThreadWorkspaceGroup = typeof ThreadWorkspaceGroup.Type;

const ThreadWorkspaceGroupRawRow = Schema.Struct({
  ownerThreadId: Schema.Unknown,
  projectId: Schema.Unknown,
  branch: Schema.Unknown,
  worktreePath: Schema.Unknown,
  isReady: Schema.Unknown,
});

const decodeGroup = Schema.decodeUnknownEffect(ThreadWorkspaceGroup);

export interface ThreadWorkspaceGroupKey {
  readonly ownerThreadId: ThreadId;
  readonly projectId: ProjectId;
}

export class ThreadWorkspaceGroupRepository extends Context.Service<
  ThreadWorkspaceGroupRepository,
  {
    /**
     * Reserve this parent's worktree for this repository, or read the
     * reservation somebody else already won. The returned row is authoritative
     * for every caller.
     */
    readonly claim: (input: {
      readonly ownerThreadId: ThreadId;
      readonly projectId: ProjectId;
      readonly branch: string;
      readonly worktreePath: string;
      readonly createdAt: string;
    }) => Effect.Effect<ThreadWorkspaceGroup, ThreadWorkspaceGroupRepositoryError>;
    readonly get: (
      key: ThreadWorkspaceGroupKey,
    ) => Effect.Effect<Option.Option<ThreadWorkspaceGroup>, ThreadWorkspaceGroupRepositoryError>;
    /** Record that the reserved worktree now exists on disk. */
    readonly markReady: (input: {
      readonly ownerThreadId: ThreadId;
      readonly projectId: ProjectId;
      readonly worktreePath: string;
    }) => Effect.Effect<void, ThreadWorkspaceGroupRepositoryError>;
  }
>()("t3/persistence/ThreadWorkspaceGroups/ThreadWorkspaceGroupRepository") {}

function mapError(operation: string) {
  return (cause: unknown): ThreadWorkspaceGroupRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const groupColumns = sql`
    owner_thread_id AS "ownerThreadId",
    project_id AS "projectId",
    branch AS "branch",
    worktree_path AS "worktreePath",
    ready AS "isReady"
  `;

  const insertGroupRow = SqlSchema.void({
    Request: Schema.Struct({
      ownerThreadId: ThreadId,
      projectId: ProjectId,
      branch: Schema.String,
      worktreePath: Schema.String,
      createdAt: Schema.String,
    }),
    execute: (input) => sql`
      INSERT INTO thread_workspace_groups (
        owner_thread_id, project_id, branch, worktree_path, ready, created_at
      ) VALUES (
        ${input.ownerThreadId}, ${input.projectId}, ${input.branch},
        ${input.worktreePath}, 0, ${input.createdAt}
      )
      ON CONFLICT(owner_thread_id, project_id) DO NOTHING
    `,
  });

  const getGroupRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ ownerThreadId: ThreadId, projectId: ProjectId }),
    Result: ThreadWorkspaceGroupRawRow,
    execute: ({ ownerThreadId, projectId }) => sql`
      SELECT ${groupColumns} FROM thread_workspace_groups
      WHERE owner_thread_id = ${ownerThreadId} AND project_id = ${projectId}
    `,
  });

  // Matching on the path as well as the key keeps a stale writer from marking
  // somebody else's reservation ready after a group was rebuilt.
  const markGroupReadyRow = SqlSchema.void({
    Request: Schema.Struct({
      ownerThreadId: ThreadId,
      projectId: ProjectId,
      worktreePath: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE thread_workspace_groups SET ready = 1
      WHERE owner_thread_id = ${input.ownerThreadId}
        AND project_id = ${input.projectId}
        AND worktree_path = ${input.worktreePath}
    `,
  });

  const decodeRow = (row: unknown) =>
    decodeGroup({
      ...(row as Record<string, unknown>),
      isReady: Boolean((row as { isReady?: unknown }).isReady),
    });

  const read = (key: ThreadWorkspaceGroupKey, operation: string) =>
    getGroupRow(key).pipe(
      Effect.mapError(mapError(operation)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<ThreadWorkspaceGroup>()),
          onSome: (row) =>
            decodeRow(row).pipe(Effect.map(Option.some), Effect.mapError(mapError(operation))),
        }),
      ),
    );

  return ThreadWorkspaceGroupRepository.of({
    claim: (input) =>
      Effect.gen(function* () {
        yield* insertGroupRow(input).pipe(Effect.mapError(mapError("ThreadWorkspaceGroups.claim")));
        const existing = yield* read(input, "ThreadWorkspaceGroups.claim");
        // The row is written before it is read inside the same call, so a none
        // here means the table lost the write rather than a lost race.
        return Option.getOrElse(existing, () => ({
          ownerThreadId: input.ownerThreadId,
          projectId: input.projectId,
          branch: input.branch,
          worktreePath: input.worktreePath,
          isReady: false,
        }));
      }),

    get: (key) => read(key, "ThreadWorkspaceGroups.get"),

    markReady: (input) =>
      markGroupReadyRow(input).pipe(Effect.mapError(mapError("ThreadWorkspaceGroups.markReady"))),
  });
});

export const layer = Layer.effect(ThreadWorkspaceGroupRepository, make);
