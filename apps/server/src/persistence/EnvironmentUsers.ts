import { EnvironmentUserId, EnvironmentUserRole, EnvironmentUserStatus } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type EnvironmentUserRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const EnvironmentUserRecord = Schema.Struct({
  userId: EnvironmentUserId,
  displayName: Schema.NullOr(Schema.String),
  primaryEmail: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  role: EnvironmentUserRole,
  status: EnvironmentUserStatus,
  firstSeenAt: Schema.DateTimeUtcFromString,
  lastSeenAt: Schema.DateTimeUtcFromString,
});
export type EnvironmentUserRecord = typeof EnvironmentUserRecord.Type;

export const UpsertEnvironmentUserInput = Schema.Struct({
  ...EnvironmentUserRecord.fields,
});
export type UpsertEnvironmentUserInput = typeof UpsertEnvironmentUserInput.Type;

export const UpdateEnvironmentUserInput = Schema.Struct({
  userId: EnvironmentUserId,
  role: Schema.optional(EnvironmentUserRole),
  status: Schema.optional(EnvironmentUserStatus),
});
export type UpdateEnvironmentUserInput = typeof UpdateEnvironmentUserInput.Type;

const EnvironmentUserRawDbRow = Schema.Struct({
  userId: Schema.String,
  displayName: Schema.Unknown,
  primaryEmail: Schema.Unknown,
  avatarUrl: Schema.Unknown,
  role: Schema.Unknown,
  status: Schema.Unknown,
  firstSeenAt: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
});

export class EnvironmentUserRepository extends Context.Service<
  EnvironmentUserRepository,
  {
    readonly upsert: (
      input: UpsertEnvironmentUserInput,
    ) => Effect.Effect<void, EnvironmentUserRepositoryError>;
    readonly get: (
      userId: EnvironmentUserId,
    ) => Effect.Effect<Option.Option<EnvironmentUserRecord>, EnvironmentUserRepositoryError>;
    readonly list: Effect.Effect<
      ReadonlyArray<EnvironmentUserRecord>,
      EnvironmentUserRepositoryError
    >;
    readonly update: (
      input: UpdateEnvironmentUserInput,
    ) => Effect.Effect<boolean, EnvironmentUserRepositoryError>;
  }
>()("t3/persistence/EnvironmentUsers/EnvironmentUserRepository") {}

const decodeRow = Schema.decodeUnknownEffect(EnvironmentUserRecord);

function mapRepositoryError(operation: string, userId?: EnvironmentUserId) {
  return (cause: unknown): EnvironmentUserRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(
          `${operation}:decode`,
          cause,
          userId ? { userId } : undefined,
        )
      : new PersistenceSqlError({
          operation: `${operation}:query`,
          ...(userId ? { correlation: { userId } } : {}),
          cause,
        });
}

function decodeRows(
  rows: ReadonlyArray<typeof EnvironmentUserRawDbRow.Type>,
): Effect.Effect<ReadonlyArray<EnvironmentUserRecord>, PersistenceDecodeError> {
  return Effect.forEach(rows, (row) =>
    decodeRow(row).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError(
          "EnvironmentUserRepository.list:decode",
          cause,
          typeof row.userId === "string" ? { userId: row.userId } : undefined,
        ),
      ),
    ),
  );
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectColumns = sql`
    user_id AS "userId",
    display_name AS "displayName",
    primary_email AS "primaryEmail",
    avatar_url AS "avatarUrl",
    role AS "role",
    status AS "status",
    first_seen_at AS "firstSeenAt",
    last_seen_at AS "lastSeenAt"
  `;

  const upsertRow = SqlSchema.void({
    Request: UpsertEnvironmentUserInput,
    execute: (input) => sql`
      INSERT INTO environment_users (
        user_id,
        display_name,
        primary_email,
        avatar_url,
        role,
        status,
        first_seen_at,
        last_seen_at
      ) VALUES (
        ${input.userId},
        ${input.displayName},
        ${input.primaryEmail},
        ${input.avatarUrl},
        ${input.role},
        ${input.status},
        ${input.firstSeenAt},
        ${input.lastSeenAt}
      )
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = COALESCE(excluded.display_name, environment_users.display_name),
        primary_email = COALESCE(excluded.primary_email, environment_users.primary_email),
        avatar_url = COALESCE(excluded.avatar_url, environment_users.avatar_url),
        last_seen_at = excluded.last_seen_at
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: EnvironmentUserId }),
    Result: EnvironmentUserRawDbRow,
    execute: ({ userId }) => sql`
      SELECT ${selectColumns}
      FROM environment_users
      WHERE user_id = ${userId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EnvironmentUserRawDbRow,
    execute: () => sql`
      SELECT ${selectColumns}
      FROM environment_users
      ORDER BY last_seen_at DESC, user_id ASC
    `,
  });

  const updateRow = SqlSchema.findAll({
    Request: UpdateEnvironmentUserInput,
    Result: Schema.Struct({ userId: EnvironmentUserId }),
    execute: (input) => sql`
      UPDATE environment_users
      SET
        role = COALESCE(${input.role ?? null}, role),
        status = COALESCE(${input.status ?? null}, status)
      WHERE user_id = ${input.userId}
      RETURNING user_id AS "userId"
    `,
  });

  const upsert: EnvironmentUserRepository["Service"]["upsert"] = (input) =>
    upsertRow(input).pipe(
      Effect.mapError(mapRepositoryError("EnvironmentUserRepository.upsert", input.userId)),
    );

  const get: EnvironmentUserRepository["Service"]["get"] = (userId) =>
    getRow({ userId }).pipe(
      Effect.mapError(mapRepositoryError("EnvironmentUserRepository.get", userId)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRow(row).pipe(
              Effect.map(Option.some),
              Effect.mapError(mapRepositoryError("EnvironmentUserRepository.get", userId)),
            ),
        }),
      ),
    );

  const list: EnvironmentUserRepository["Service"]["list"] = listRows(undefined).pipe(
    Effect.mapError(mapRepositoryError("EnvironmentUserRepository.list")),
    Effect.flatMap(decodeRows),
  );

  const update: EnvironmentUserRepository["Service"]["update"] = (input) =>
    updateRow(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapRepositoryError("EnvironmentUserRepository.update", input.userId)),
    );

  return EnvironmentUserRepository.of({ upsert, get, list, update });
});

export const layer = Layer.effect(EnvironmentUserRepository, make);
