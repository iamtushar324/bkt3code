/**
 * T3-CUSTOM(expbkt3): persistence for the Claude account a thread runs on.
 *
 * One row per thread: the mode the user chose (`auto` or a pinned profile),
 * the account the thread last resolved to, and its place in the revive queue
 * when no account could take it. An absent row means `auto` with nothing
 * resolved and no wait.
 */
import { CLAUDE_ACCOUNT_MODE_AUTO, ClaudeAccountMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export type ThreadClaudeAccountRepositoryError = ProjectionRepositoryError;

/** A thread waiting in the revive queue (migration 1053). */
export interface ThreadClaudeAccountWait {
  readonly queuedAt: string;
  /** A turn was in flight when it stopped, so the revive sends the continue turn. */
  readonly wasActive: boolean;
  /** A short reset wait: continue on this account once `notBefore` passes. */
  readonly preferProfile: string | null;
  readonly notBefore: string | null;
}

export interface ThreadClaudeAccountRow {
  readonly threadId: ThreadId;
  readonly mode: ClaudeAccountMode;
  readonly resolvedProfile: string | null;
  readonly resolvedAt: string | null;
  readonly updatedAt: string;
  readonly wait: ThreadClaudeAccountWait | null;
}

const DbRow = Schema.Struct({
  threadId: ThreadId,
  mode: Schema.fromJsonString(ClaudeAccountMode),
  resolvedProfile: Schema.NullOr(Schema.String),
  resolvedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  waitQueuedAt: Schema.NullOr(Schema.String),
  waitWasActive: Schema.NullOr(Schema.Number),
  waitPreferProfile: Schema.NullOr(Schema.String),
  waitNotBefore: Schema.NullOr(Schema.String),
});

const fromDbRow = (row: typeof DbRow.Type): ThreadClaudeAccountRow => ({
  threadId: row.threadId,
  mode: row.mode,
  resolvedProfile: row.resolvedProfile,
  resolvedAt: row.resolvedAt,
  updatedAt: row.updatedAt,
  wait:
    row.waitQueuedAt === null
      ? null
      : {
          queuedAt: row.waitQueuedAt,
          wasActive: row.waitWasActive === 1,
          preferProfile: row.waitPreferProfile,
          notBefore: row.waitNotBefore,
        },
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
    /** Puts the thread in the revive queue (or replaces its entry); mode and account are kept. */
    readonly setWait: (input: {
      readonly threadId: ThreadId;
      readonly wait: ThreadClaudeAccountWait;
    }) => Effect.Effect<void, ThreadClaudeAccountRepositoryError>;
    /** Takes the thread out of the revive queue; a missing row is a no-op. */
    readonly clearWait: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ThreadClaudeAccountRepositoryError>;
    /** Every thread in the revive queue, oldest first. */
    readonly listWaiting: () => Effect.Effect<
      ReadonlyArray<ThreadClaudeAccountRow>,
      ThreadClaudeAccountRepositoryError
    >;
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
  wait: null,
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = sql`
    thread_id AS "threadId",
    mode_json AS "mode",
    resolved_profile AS "resolvedProfile",
    resolved_at AS "resolvedAt",
    updated_at AS "updatedAt",
    wait_queued_at AS "waitQueuedAt",
    wait_was_active AS "waitWasActive",
    wait_prefer_profile AS "waitPreferProfile",
    wait_not_before AS "waitNotBefore"
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

  const listWaitingRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DbRow,
    execute: () => sql`
      SELECT ${columns} FROM thread_claude_account
      WHERE wait_queued_at IS NOT NULL
      ORDER BY wait_queued_at ASC
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

  const setWaitRow = SqlSchema.void({
    Request: Schema.Struct({
      threadId: ThreadId,
      queuedAt: Schema.String,
      // SQLite has no boolean; node:sqlite refuses one as a parameter.
      wasActive: Schema.Number,
      preferProfile: Schema.NullOr(Schema.String),
      notBefore: Schema.NullOr(Schema.String),
    }),
    execute: ({ threadId, queuedAt, wasActive, preferProfile, notBefore }) => sql`
      INSERT INTO thread_claude_account (
        thread_id, mode_json, resolved_profile, resolved_at, updated_at,
        wait_queued_at, wait_was_active, wait_prefer_profile, wait_not_before
      )
      VALUES (
        ${threadId}, ${JSON.stringify(CLAUDE_ACCOUNT_MODE_AUTO)}, NULL, NULL, ${queuedAt},
        ${queuedAt}, ${wasActive}, ${preferProfile}, ${notBefore}
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        wait_queued_at = ${queuedAt},
        wait_was_active = ${wasActive},
        wait_prefer_profile = ${preferProfile},
        wait_not_before = ${notBefore}
    `,
  });

  const clearWaitRow = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`
      UPDATE thread_claude_account SET
        wait_queued_at = NULL,
        wait_was_active = NULL,
        wait_prefer_profile = NULL,
        wait_not_before = NULL
      WHERE thread_id = ${threadId}
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
        Effect.map(Option.match({ onNone: () => defaultRow(threadId), onSome: fromDbRow })),
        Effect.mapError(mapError("ThreadClaudeAccount.get")),
      ),
    setMode: ({ threadId, mode, updatedAt }) =>
      setModeRow({ threadId, modeJson: JSON.stringify(mode), updatedAt }).pipe(
        Effect.mapError(mapError("ThreadClaudeAccount.setMode")),
      ),
    setResolved: (input) =>
      setResolvedRow(input).pipe(Effect.mapError(mapError("ThreadClaudeAccount.setResolved"))),
    setWait: ({ threadId, wait }) =>
      setWaitRow({
        threadId,
        queuedAt: wait.queuedAt,
        wasActive: wait.wasActive ? 1 : 0,
        preferProfile: wait.preferProfile,
        notBefore: wait.notBefore,
      }).pipe(Effect.mapError(mapError("ThreadClaudeAccount.setWait"))),
    clearWait: (threadId) =>
      clearWaitRow({ threadId }).pipe(Effect.mapError(mapError("ThreadClaudeAccount.clearWait"))),
    listWaiting: () =>
      listWaitingRows(undefined).pipe(
        Effect.map((rows) => rows.map(fromDbRow)),
        Effect.mapError(mapError("ThreadClaudeAccount.listWaiting")),
      ),
    listByProfile: (profile) =>
      listRows({ profile }).pipe(
        Effect.map((rows) => rows.map(fromDbRow)),
        Effect.mapError(mapError("ThreadClaudeAccount.listByProfile")),
      ),
    delete: (threadId) =>
      deleteRow({ threadId }).pipe(Effect.mapError(mapError("ThreadClaudeAccount.delete"))),
  });
});

export const layer = Layer.effect(ThreadClaudeAccountRepository, make);
