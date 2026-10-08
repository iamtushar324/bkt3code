import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { AuthEnvironmentScopes } from "@t3tools/contracts";

import {
  type AuthPairingLinkRepositoryError,
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
} from "./Errors.ts";

export const AuthPairingLinkRecord = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  scopes: Schema.fromJsonString(AuthEnvironmentScopes),
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  // T3-CUSTOM(expbkt3): redeem only with a DPoP proof; see migration 1014.
  requiresProofOfPossession: Schema.Boolean,
  // T3-CUSTOM(expbkt3): minted by a member for their own device; see migration 1015.
  selfIssued: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthPairingLinkRecord = typeof AuthPairingLinkRecord.Type;

export const CreateAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  scopes: AuthEnvironmentScopes,
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  // T3-CUSTOM(expbkt3): see AuthPairingLinkRecord.
  requiresProofOfPossession: Schema.Boolean,
  // T3-CUSTOM(expbkt3): see AuthPairingLinkRecord.
  selfIssued: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CreateAuthPairingLinkInput = typeof CreateAuthPairingLinkInput.Type;

export const ConsumeAuthPairingLinkInput = Schema.Struct({
  credential: Schema.String,
  proofKeyThumbprint: Schema.NullOr(Schema.String),
  requestedScopes: Schema.optionalKey(AuthEnvironmentScopes),
  consumedAt: Schema.DateTimeUtcFromString,
  now: Schema.DateTimeUtcFromString,
});
export type ConsumeAuthPairingLinkInput = typeof ConsumeAuthPairingLinkInput.Type;

export const ListActiveAuthPairingLinksInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthPairingLinksInput = typeof ListActiveAuthPairingLinksInput.Type;

export const RevokeAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthPairingLinkInput = typeof RevokeAuthPairingLinkInput.Type;

export const GetAuthPairingLinkByCredentialInput = Schema.Struct({
  credential: Schema.String,
});
export type GetAuthPairingLinkByCredentialInput = typeof GetAuthPairingLinkByCredentialInput.Type;

const AuthPairingLinkRawDbRow = Schema.Struct({
  id: Schema.String,
  credential: Schema.Unknown,
  method: Schema.Unknown,
  scopes: Schema.Unknown,
  subject: Schema.Unknown,
  label: Schema.Unknown,
  proofKeyThumbprint: Schema.Unknown,
  // T3-CUSTOM(expbkt3): proof-of-possession requirement.
  requiresProofOfPossession: Schema.Unknown,
  // T3-CUSTOM(expbkt3): member self-service marker.
  selfIssued: Schema.Unknown,
  createdAt: Schema.Unknown,
  expiresAt: Schema.Unknown,
  consumedAt: Schema.Unknown,
  revokedAt: Schema.Unknown,
});

const decodeAuthPairingLinkRecord = Schema.decodeUnknownEffect(AuthPairingLinkRecord);

// T3-CUSTOM(expbkt3): BEGIN - SQLite has no boolean type, so the fork's
// requires_proof_of_possession column arrives as 0/1 (and as NULL from a row written
// before migration 1014 on some drivers). Normalizing here rather than at each decode
// site keeps every read path in agreement.
const decodeAuthPairingLinkDbRow = (row: unknown) =>
  decodeAuthPairingLinkRecord(
    typeof row === "object" && row !== null
      ? {
          ...row,
          requiresProofOfPossession:
            (row as { readonly requiresProofOfPossession?: unknown }).requiresProofOfPossession ===
              1 ||
            (row as { readonly requiresProofOfPossession?: unknown }).requiresProofOfPossession ===
              true,
          selfIssued:
            (row as { readonly selfIssued?: unknown }).selfIssued === 1 ||
            (row as { readonly selfIssued?: unknown }).selfIssued === true,
        }
      : row,
  );
// T3-CUSTOM(expbkt3): END

export class AuthPairingLinkRepository extends Context.Service<
  AuthPairingLinkRepository,
  {
    readonly create: (
      input: CreateAuthPairingLinkInput,
    ) => Effect.Effect<void, AuthPairingLinkRepositoryError>;
    readonly consumeAvailable: (
      input: ConsumeAuthPairingLinkInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly listActive: (
      input: ListActiveAuthPairingLinksInput,
    ) => Effect.Effect<ReadonlyArray<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
    readonly revoke: (
      input: RevokeAuthPairingLinkInput,
    ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
    readonly getByCredential: (
      input: GetAuthPairingLinkByCredentialInput,
    ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
  }
>()("t3/persistence/AuthPairingLinks/AuthPairingLinkRepository") {}

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): AuthPairingLinkRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const createPairingLinkRow = SqlSchema.void({
    Request: CreateAuthPairingLinkInput,
    execute: (input) =>
      sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          label,
          proof_key_thumbprint,
          -- T3-CUSTOM(expbkt3): proof-of-possession requirement.
          requires_proof_of_possession,
          -- T3-CUSTOM(expbkt3): member self-service marker.
          self_issued,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          ${input.id},
          ${input.credential},
          ${input.method},
          ${JSON.stringify(input.scopes)},
          ${input.subject},
          ${input.label},
          ${input.proofKeyThumbprint},
          -- T3-CUSTOM(expbkt3): proof-of-possession requirement.
          ${input.requiresProofOfPossession ? 1 : 0},
          -- T3-CUSTOM(expbkt3): member self-service marker.
          ${input.selfIssued ? 1 : 0},
          ${input.createdAt},
          ${input.expiresAt},
          NULL,
          NULL
        )
      `,
  });

  const consumeAvailablePairingLinkRow = SqlSchema.findOneOption({
    Request: ConsumeAuthPairingLinkInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ credential, proofKeyThumbprint, requestedScopes, consumedAt, now }) =>
      sql`
        UPDATE auth_pairing_links
        SET consumed_at = ${consumedAt}
        WHERE credential = ${credential}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
          AND (
            proof_key_thumbprint IS NULL
            OR proof_key_thumbprint = ${proofKeyThumbprint}
          )
          -- T3-CUSTOM(expbkt3): a link that requires proof-of-possession only consumes
          -- when the caller presented a verified DPoP proof. Gating here rather than
          -- after the fact means a redemption without one does not burn the credential.
          AND (
            requires_proof_of_possession = 0
            OR ${proofKeyThumbprint} IS NOT NULL
          )
          -- T3-CUSTOM(expbkt3): bind 1/0, not a boolean; node:sqlite on Node 24.16 (stage) refuses booleans.
          AND (${requestedScopes === undefined ? 1 : 0} OR EXISTS (
            SELECT 1
            FROM json_each(${JSON.stringify(requestedScopes ?? [])}) AS requested
            WHERE requested.value IN (
              SELECT value FROM json_each(auth_pairing_links.scopes)
            )
          ))
        RETURNING
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          -- T3-CUSTOM(expbkt3): proof-of-possession requirement.
          requires_proof_of_possession AS "requiresProofOfPossession",
          -- T3-CUSTOM(expbkt3): member self-service marker.
          self_issued AS "selfIssued",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt"
      `,
  });

  const listActivePairingLinkRows = SqlSchema.findAll({
    Request: ListActiveAuthPairingLinksInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ now }) =>
      sql`
        SELECT
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          -- T3-CUSTOM(expbkt3): proof-of-possession requirement.
          requires_proof_of_possession AS "requiresProofOfPossession",
          -- T3-CUSTOM(expbkt3): member self-service marker.
          self_issued AS "selfIssued",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt"
        FROM auth_pairing_links
        WHERE revoked_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > ${now}
        ORDER BY created_at DESC, id DESC
      `,
  });

  const revokePairingLinkRow = SqlSchema.findAll({
    Request: RevokeAuthPairingLinkInput,
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE auth_pairing_links
        SET revoked_at = ${revokedAt}
        WHERE id = ${id}
          AND revoked_at IS NULL
          AND consumed_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const getPairingLinkRowByCredential = SqlSchema.findOneOption({
    Request: GetAuthPairingLinkByCredentialInput,
    Result: AuthPairingLinkRawDbRow,
    execute: ({ credential }) =>
      sql`
        SELECT
          id AS "id",
          credential AS "credential",
          method AS "method",
          scopes AS "scopes",
          subject AS "subject",
          label AS "label",
          proof_key_thumbprint AS "proofKeyThumbprint",
          -- T3-CUSTOM(expbkt3): proof-of-possession requirement.
          requires_proof_of_possession AS "requiresProofOfPossession",
          -- T3-CUSTOM(expbkt3): member self-service marker.
          self_issued AS "selfIssued",
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          consumed_at AS "consumedAt",
          revoked_at AS "revokedAt"
        FROM auth_pairing_links
        WHERE credential = ${credential}
      `,
  });

  const create: AuthPairingLinkRepository["Service"]["create"] = (input) =>
    createPairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.create:query",
          "AuthPairingLinkRepository.create:encodeRequest",
          { pairingLinkId: input.id },
        ),
      ),
    );

  const consumeAvailable: AuthPairingLinkRepository["Service"]["consumeAvailable"] = (input) =>
    consumeAvailablePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.consumeAvailable:query",
          "AuthPairingLinkRepository.consumeAvailable:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.consumeAvailable:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  const listActive: AuthPairingLinkRepository["Service"]["listActive"] = (input) =>
    listActivePairingLinkRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.listActive:query",
          "AuthPairingLinkRepository.listActive:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeAuthPairingLinkDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "AuthPairingLinkRepository.listActive:decodeRows",
                cause,
                { pairingLinkId: row.id },
              ),
            ),
          ),
        ),
      ),
    );

  const revoke: AuthPairingLinkRepository["Service"]["revoke"] = (input) =>
    revokePairingLinkRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.revoke:query",
          "AuthPairingLinkRepository.revoke:decodeRows",
          { pairingLinkId: input.id },
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const getByCredential: AuthPairingLinkRepository["Service"]["getByCredential"] = (input) =>
    getPairingLinkRowByCredential(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "AuthPairingLinkRepository.getByCredential:query",
          "AuthPairingLinkRepository.getByCredential:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            decodeAuthPairingLinkDbRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "AuthPairingLinkRepository.getByCredential:decodeRow",
                  cause,
                  { pairingLinkId: row.id },
                ),
              ),
              Effect.asSome,
            ),
        }),
      ),
    );

  return {
    create,
    consumeAvailable,
    listActive,
    revoke,
    getByCredential,
  } satisfies AuthPairingLinkRepository["Service"];
});

export const layer = Layer.effect(AuthPairingLinkRepository, make);
