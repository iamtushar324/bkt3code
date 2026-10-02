/**
 * T3-CUSTOM(expbkt3): persistence for who may use each Claude account.
 *
 * One row per (account, user). An account with no rows is open to everyone;
 * once it has rows, only those users may use it. Admins replace an account's
 * whole list at once.
 */
import { UserId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type ProjectionRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export type ClaudeAccountProfileAccessRepositoryError = ProjectionRepositoryError;

export interface ClaudeAccountProfileAccessEntry {
  readonly profile: string;
  readonly userIds: ReadonlyArray<UserId>;
}

const DbRow = Schema.Struct({
  profile: Schema.String,
  userId: UserId,
});

export class ClaudeAccountProfileAccessRepository extends Context.Service<
  ClaudeAccountProfileAccessRepository,
  {
    /** Every account with an allow list, by name; user ids sorted. */
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<ClaudeAccountProfileAccessEntry>,
      ClaudeAccountProfileAccessRepositoryError
    >;
    /**
     * Replaces one account's allow list. Users already on it keep their
     * original `added_*` stamp; an empty list opens the account to everyone.
     */
    readonly setUsers: (input: {
      readonly profile: string;
      readonly userIds: ReadonlyArray<UserId>;
      readonly addedByUserId: UserId | null;
      readonly addedAt: string;
    }) => Effect.Effect<void, ClaudeAccountProfileAccessRepositoryError>;
  }
>()("t3/persistence/ClaudeAccountProfileAccess/ClaudeAccountProfileAccessRepository") {}

function mapError(operation: string) {
  return (cause: unknown): ClaudeAccountProfileAccessRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(`${operation}:decode`, cause)
      : new PersistenceSqlError({ operation: `${operation}:query`, cause });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({}),
    Result: DbRow,
    execute: () => sql`
      SELECT profile, user_id AS "userId"
      FROM claude_account_profile_access
      ORDER BY profile ASC, user_id ASC
    `,
  });

  const listAll = () =>
    listRows({}).pipe(
      Effect.map((rows) => {
        const byProfile = new Map<string, Array<UserId>>();
        for (const row of rows) {
          const users = byProfile.get(row.profile);
          if (users === undefined) byProfile.set(row.profile, [row.userId]);
          else users.push(row.userId);
        }
        return [...byProfile].map(([profile, userIds]) => ({ profile, userIds }));
      }),
      Effect.mapError(mapError("ClaudeAccountProfileAccess.listAll")),
    );

  const setUsers: ClaudeAccountProfileAccessRepository["Service"]["setUsers"] = (input) => {
    const userIds = [...new Set(input.userIds)];
    return sql
      .withTransaction(
        Effect.gen(function* () {
          if (userIds.length === 0) {
            yield* sql`DELETE FROM claude_account_profile_access WHERE profile = ${input.profile}`;
            return;
          }
          yield* sql`
            DELETE FROM claude_account_profile_access
            WHERE profile = ${input.profile} AND user_id NOT IN ${sql.in(userIds)}
          `;
          yield* Effect.forEach(
            userIds,
            (userId) => sql`
              INSERT INTO claude_account_profile_access (profile, user_id, added_by_user_id, added_at)
              VALUES (${input.profile}, ${userId}, ${input.addedByUserId}, ${input.addedAt})
              ON CONFLICT(profile, user_id) DO NOTHING
            `,
            { discard: true },
          );
        }),
      )
      .pipe(Effect.mapError(mapError("ClaudeAccountProfileAccess.setUsers")));
  };

  return ClaudeAccountProfileAccessRepository.of({ listAll, setUsers });
});

export const layer = Layer.effect(ClaudeAccountProfileAccessRepository, make);
