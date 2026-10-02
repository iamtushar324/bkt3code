/**
 * T3-CUSTOM(expbkt3): persistence for the Claude account a thread runs on.
 *
 * One row per thread, rewritten whole: the mode the user chose (`auto` or a
 * pinned profile) plus the account the thread last resolved to. An absent row
 * means `auto` with nothing resolved yet.
 */
import { CLAUDE_ACCOUNT_MODE_AUTO, ClaudeAccountMode, ThreadId } from "@t3tools/contracts";
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

export type ThreadClaudeAccountRepositoryError = ProjectionRepositoryError;

export interface ThreadClaudeAccountRow {
  readonly threadId: ThreadId;
  readonly mode: ClaudeAccountMode;
  readonly resolvedProfile: string | null;
  readonly resolvedAt: string | null;
  readonly updatedAt: string;
}

const DbRow = Schema.Struct({
  threadId: ThreadId,
  mode: Schema.fromJsonString(ClaudeAccountMode),
  resolvedProfile: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

export class ThreadClaudeAccountRepository extends Context.Service<
  ThreadClaudeAccountRepository,
  {
    /** The stored row, or the `auto` default when the thread has none. */
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadClaudeAccountRow, ThreadClaudeAccountRepositoryError>;
    /** Replaces the mode; the resolved account is kept. */
    readonly setMode: (input: {
      readonly threadId: ThreadId;
      readonly mode: ClaudeAccountMode;
      readonly updatedAt: string;
    }) => Effect.Effect<void, ThreadClaudeAccountRepositoryError>;
    /** Records the account a session was placed on; the mode is kept. */
    readonly setResolved: (input: {
      readonly threadId: ThreadId;
      readonly profile: string;
      readonly resolvedAt: string;
    }) => Effect.Effect<void, ThreadClaudeAccountRepositoryError>;
    /** Every thread whose last session ran on the given account. */
    readonly listByProfile: (
      profile: string,
    ) => Effect.Effect<ReadonlyArray<ThreadClaudeAccountRow>, ThreadClaudeAccountRepositoryError>;
    /** Drops the row; a missing row is a no-op. */
    readonly delete: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadClaudeAccountRepositoryError>;
  }
>()("t3/persistence/ThreadClaudeAccount/ThreadClaudeAccountRepository") {}

function mapError(operation: string) {
  return (cause: unknown): ThreadClaudeAccountRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

export const defaultRow = (threadId: ThreadId): ThreadClaudeAccountRow => ({
  threadId,
  mode: CLAUDE_ACCOUNT_MODE_AUTO,
  resolvedProfile: null,
  resolvedAt: null,
  updatedAt: "1970-01-01T00:00:00.000Z",
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql`
    thread_id AS "threadId",
    mode_json AS "mode",
    resolved_profile AS "resolvedProfile",
    resolved_at AS "resolvedAt",
    updated_at AS "updatedAt"
  `;

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: DbRow,
    execute: ({ threadId }) => sql`
      SELECT ${columns} FROM thread_claude_account WHERE thread_id = ${threadId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({ profile: Schema.String }),
    Result: DbRow,
    execute: ({ profile }) => sql`
      SELECT ${columns} FROM thread_claude_account
      WHERE resolved_profile = ${profile}
      ORDER BY updated_at ASC
    `,
  });

  const setModeRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      modeJson: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: ({ threadId, modeJson, updatedAt }) => sql`
      INSERT INTO thread_claude_account (thread_id, mode_json, resolved_profile, resolved_at, updated_at)
      VALUES (${threadId}, ${modeJson}, NULL, NULL, ${updatedAt})
      ON CONFLICT(thread_id) DO UPDATE SET mode_json = ${modeJson}, updated_at = ${updatedAt}
    `,
  });

  const setResolvedRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      profile: Schema.String,
      resolvedAt: Schema.String,
    }),
    execute: ({ threadId, profile, resolvedAt }) => sql`
      INSERT INTO thread_claude_account (thread_id, mode_json, resolved_profile, resolved_at, updated_at)
      VALUES (${threadId}, ${JSON.stringify(CLAUDE_ACCOUNT_MODE_AUTO)}, ${profile}, ${resolvedAt}, ${resolvedAt})
      ON CONFLICT(thread_id) DO UPDATE SET
        resolved_profile = ${profile},
        resolved_at = ${resolvedAt},
        updated_at = ${resolvedAt}
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`
      DELETE FROM thread_claude_account WHERE thread_id = ${threadId}
    `,
  });

  return ThreadClaudeAccountRepository.of({
    get: (threadId) =>
      getRow({ threadId }).pipe(
        Effect.map(Option.getOrElse(() => defaultRow(threadId))),
        Effect.mapError(mapError("ThreadClaudeAccount.get")),
      ),
    setMode: ({ threadId, mode, updatedAt }) =>
      setModeRow({ threadId, modeJson: JSON.stringify(mode), updatedAt }).pipe(
        Effect.mapError(mapError("ThreadClaudeAccount.setMode")),
      ),
    setResolved: (input) =>
      setResolvedRow(input).pipe(Effect.mapError(mapError("ThreadClaudeAccount.setResolved"))),
    listByProfile: (profile) =>
      listRows({ profile }).pipe(Effect.mapError(mapError("ThreadClaudeAccount.listByProfile"))),
    delete: (threadId) =>
      deleteRow({ threadId }).pipe(Effect.mapError(mapError("ThreadClaudeAccount.delete"))),
  });
});

export const layer = Layer.effect(ThreadClaudeAccountRepository, make);
