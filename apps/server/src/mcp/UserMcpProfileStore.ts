/**
 * T3-CUSTOM(expbkt3): Durable per-user MCP integration store.
 *
 * Metadata is stored in SQLite. Raw upstream credentials are stored as
 * user/integration-namespaced ServerSecretStore entries and never returned.
 */
import {
  BIFROST_MCP_URL,
  PersonalMcpProfile,
  type PersonalMcpProfileUpdate,
  PersonalMcpSettingsError,
  PersonalMcpIntegration,
  type PersonalMcpIntegrationId,
  UserId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const StoredProfile = Schema.Struct({
  externalAccessEnabled: Schema.Boolean,
  integrations: Schema.Array(PersonalMcpIntegration),
});
type StoredProfile = typeof StoredProfile.Type;
const StoredProfileJson = Schema.fromJsonString(StoredProfile);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface ProfileRow {
  readonly userId: string;
  readonly profileJson: string;
  readonly externalTokenHash: string | null;
  readonly externalTokenPrefix: string | null;
  readonly tokenCreatedAt: string | null;
  readonly tokenLastUsedAt: string | null;
  readonly updatedAt: string;
}

const defaultStoredProfile = (): StoredProfile => ({
  externalAccessEnabled: false,
  integrations: [],
});

const fail = (operation: string, cause: unknown) =>
  new PersonalMcpSettingsError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const hash = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const secretName = (userId: UserId, integrationId: PersonalMcpIntegrationId): string =>
  `user-mcp-${hash(`${userId}\0${integrationId}`)}`;

export const canonicalizePersonalMcpIntegration = <
  T extends PersonalMcpProfileUpdate["integrations"][number] | PersonalMcpIntegration,
>(
  integration: T,
): T =>
  integration.authMode === "x-bf-vk"
    ? {
        ...integration,
        name: "Bifrost",
        url: BIFROST_MCP_URL,
        authMode: "x-bf-vk",
        customHeaderName: "",
      }
    : integration;

const parseStoredProfile = Effect.fn("UserMcpProfileStore.parseStoredProfile")(function* (
  profileJson: string,
) {
  return yield* Schema.decodeUnknownEffect(StoredProfileJson)(profileJson).pipe(
    Effect.mapError((cause) => fail("decode-profile", cause)),
  );
});

const validateIntegration = (integration: PersonalMcpProfileUpdate["integrations"][number]) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(integration.id)) {
    throw new Error(`Integration id '${integration.id}' is invalid.`);
  }
  const url = new URL(integration.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Integration '${integration.id}' must use an HTTP or HTTPS URL.`);
  }
  if (
    integration.authMode === "custom-header" &&
    !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(integration.customHeaderName)
  ) {
    throw new Error(`Integration '${integration.id}' has an invalid custom header name.`);
  }
};

export interface ResolvedPersonalMcpToken {
  readonly userId: UserId;
}

export class UserMcpProfileStore extends Context.Service<
  UserMcpProfileStore,
  {
    readonly get: (userId: UserId) => Effect.Effect<PersonalMcpProfile, PersonalMcpSettingsError>;
    readonly update: (
      userId: UserId,
      input: PersonalMcpProfileUpdate,
    ) => Effect.Effect<PersonalMcpProfile, PersonalMcpSettingsError>;
    readonly rotateExternalToken: (
      userId: UserId,
    ) => Effect.Effect<
      { readonly profile: PersonalMcpProfile; readonly token: string },
      PersonalMcpSettingsError
    >;
    readonly revokeExternalToken: (
      userId: UserId,
    ) => Effect.Effect<PersonalMcpProfile, PersonalMcpSettingsError>;
    readonly resolveExternalToken: (
      rawToken: string,
    ) => Effect.Effect<ResolvedPersonalMcpToken | undefined, PersonalMcpSettingsError>;
    readonly getIntegrationCredential: (
      userId: UserId,
      integrationId: PersonalMcpIntegrationId,
    ) => Effect.Effect<string | undefined, PersonalMcpSettingsError>;
  }
>()("t3/mcp/UserMcpProfileStore") {}

let activeUserMcpProfileStore: UserMcpProfileStore["Service"] | undefined;

export const layer = Layer.effect(
  UserMcpProfileStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* ServerSecretStore.ServerSecretStore;

    const readRow = Effect.fn("UserMcpProfileStore.readRow")(function* (userId: UserId) {
      const rows = yield* sql<ProfileRow>`
        SELECT
          user_id AS "userId",
          profile_json AS "profileJson",
          external_token_hash AS "externalTokenHash",
          external_token_prefix AS "externalTokenPrefix",
          token_created_at AS "tokenCreatedAt",
          token_last_used_at AS "tokenLastUsedAt",
          updated_at AS "updatedAt"
        FROM user_mcp_profiles
        WHERE user_id = ${userId}
        LIMIT 1
      `.pipe(Effect.mapError((cause) => fail("read-profile", cause)));
      return rows[0];
    });

    const materialize = Effect.fn("UserMcpProfileStore.materialize")(function* (
      userId: UserId,
      row?: ProfileRow,
    ) {
      const stored = row ? yield* parseStoredProfile(row.profileJson) : defaultStoredProfile();
      const now = yield* nowIso;
      return PersonalMcpProfile.make({
        userId,
        externalAccessEnabled: stored.externalAccessEnabled,
        externalTokenConfigured:
          row?.externalTokenHash !== null && row?.externalTokenHash !== undefined,
        externalTokenPrefix: row?.externalTokenPrefix ?? "",
        integrations: stored.integrations.map(canonicalizePersonalMcpIntegration),
        updatedAt: row?.updatedAt ?? now,
      });
    });

    const get = Effect.fn("UserMcpProfileStore.get")(function* (userId: UserId) {
      return yield* materialize(userId, yield* readRow(userId));
    });

    const persistStored = Effect.fn("UserMcpProfileStore.persistStored")(function* (
      userId: UserId,
      stored: StoredProfile,
    ) {
      const updatedAt = yield* nowIso;
      const profileJson = yield* Schema.encodeEffect(StoredProfileJson)(stored).pipe(
        Effect.mapError((cause) => fail("encode-profile", cause)),
      );
      yield* sql`
        INSERT INTO user_mcp_profiles (user_id, profile_json, updated_at)
        VALUES (${userId}, ${profileJson}, ${updatedAt})
        ON CONFLICT(user_id) DO UPDATE SET
          profile_json = excluded.profile_json,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError((cause) => fail("write-profile", cause)));
    });

    const update = Effect.fn("UserMcpProfileStore.update")(function* (
      userId: UserId,
      input: PersonalMcpProfileUpdate,
    ) {
      const current = yield* get(userId);
      const canonicalIntegrations = input.integrations.map(canonicalizePersonalMcpIntegration);
      yield* Effect.try({
        try: () => canonicalIntegrations.forEach(validateIntegration),
        catch: (cause) => fail("validate-integration", cause),
      });
      const currentById = new Map(current.integrations.map((entry) => [entry.id, entry]));
      const nextIds = new Set(canonicalIntegrations.map((entry) => entry.id));

      for (const removed of current.integrations) {
        if (!nextIds.has(removed.id)) {
          yield* secrets
            .remove(secretName(userId, removed.id))
            .pipe(Effect.mapError((cause) => fail("remove-integration-secret", cause)));
        }
      }

      const integrations: PersonalMcpIntegration[] = [];
      for (const integration of canonicalIntegrations) {
        const existing = currentById.get(integration.id);
        let credentialConfigured = existing?.credentialConfigured ?? false;
        if (integration.credential !== undefined) {
          if (integration.credential.length === 0) {
            yield* secrets
              .remove(secretName(userId, integration.id))
              .pipe(Effect.mapError((cause) => fail("remove-integration-secret", cause)));
            credentialConfigured = false;
          } else {
            yield* secrets
              .set(secretName(userId, integration.id), textEncoder.encode(integration.credential))
              .pipe(Effect.mapError((cause) => fail("write-integration-secret", cause)));
            credentialConfigured = true;
          }
        }
        integrations.push({
          id: integration.id,
          name: integration.name,
          url: integration.url,
          enabled: integration.enabled,
          authMode: integration.authMode,
          customHeaderName: integration.customHeaderName,
          credentialConfigured,
          providerInstanceIds: integration.providerInstanceIds,
          allowedTools: integration.allowedTools,
        });
      }

      yield* persistStored(userId, {
        externalAccessEnabled: input.externalAccessEnabled,
        integrations,
      });
      return yield* get(userId);
    });

    const rotateExternalToken = Effect.fn("UserMcpProfileStore.rotateExternalToken")(function* (
      userId: UserId,
    ) {
      const current = yield* get(userId);
      const rawToken = `t3usr_${NodeCrypto.randomBytes(32).toString("base64url")}`;
      const tokenHash = hash(rawToken);
      const tokenPrefix = `${rawToken.slice(0, 14)}…`;
      const now = yield* nowIso;
      yield* persistStored(userId, {
        externalAccessEnabled: current.externalAccessEnabled,
        integrations: current.integrations,
      });
      yield* sql`
        UPDATE user_mcp_profiles
        SET external_token_hash = ${tokenHash},
            external_token_prefix = ${tokenPrefix},
            token_created_at = ${now},
            token_last_used_at = NULL,
            updated_at = ${now}
        WHERE user_id = ${userId}
      `.pipe(Effect.mapError((cause) => fail("rotate-external-token", cause)));
      return { profile: yield* get(userId), token: rawToken };
    });

    const revokeExternalToken = Effect.fn("UserMcpProfileStore.revokeExternalToken")(function* (
      userId: UserId,
    ) {
      const current = yield* get(userId);
      yield* persistStored(userId, {
        externalAccessEnabled: current.externalAccessEnabled,
        integrations: current.integrations,
      });
      const revokedAt = yield* nowIso;
      yield* sql`
        UPDATE user_mcp_profiles
        SET external_token_hash = NULL,
            external_token_prefix = NULL,
            token_created_at = NULL,
            token_last_used_at = NULL,
            updated_at = ${revokedAt}
        WHERE user_id = ${userId}
      `.pipe(Effect.mapError((cause) => fail("revoke-external-token", cause)));
      return yield* get(userId);
    });

    const resolveExternalToken = Effect.fn("UserMcpProfileStore.resolveExternalToken")(function* (
      rawToken: string,
    ) {
      if (!rawToken.startsWith("t3usr_")) return undefined;
      const tokenHash = hash(rawToken);
      const rows = yield* sql<ProfileRow>`
        SELECT
          user_id AS "userId",
          profile_json AS "profileJson",
          external_token_hash AS "externalTokenHash",
          external_token_prefix AS "externalTokenPrefix",
          token_created_at AS "tokenCreatedAt",
          token_last_used_at AS "tokenLastUsedAt",
          updated_at AS "updatedAt"
        FROM user_mcp_profiles
        WHERE external_token_hash = ${tokenHash}
        LIMIT 1
      `.pipe(Effect.mapError((cause) => fail("resolve-external-token", cause)));
      const row = rows[0];
      if (!row) return undefined;
      const profile = yield* materialize(UserId.make(row.userId), row);
      if (!profile.externalAccessEnabled) return undefined;
      const lastUsedAt = yield* nowIso;
      yield* sql`
        UPDATE user_mcp_profiles
        SET token_last_used_at = ${lastUsedAt}
        WHERE user_id = ${row.userId}
      `.pipe(Effect.mapError((cause) => fail("touch-external-token", cause)));
      return {
        userId: profile.userId,
      };
    });

    const getIntegrationCredential = Effect.fn("UserMcpProfileStore.getIntegrationCredential")(
      function* (userId: UserId, integrationId: PersonalMcpIntegrationId) {
        const value = yield* secrets
          .get(secretName(userId, integrationId))
          .pipe(Effect.mapError((cause) => fail("read-integration-secret", cause)));
        return Option.isSome(value) ? textDecoder.decode(value.value) : undefined;
      },
    );

    const service = UserMcpProfileStore.of({
      get,
      update,
      rotateExternalToken,
      revokeExternalToken,
      resolveExternalToken,
      getIntegrationCredential,
    });
    // T3-CUSTOM(expbkt3): The HTTP proxy is deliberately bound to the same
    // process-scoped store instance as WS settings and token issuance.
    yield* Effect.sync(() => {
      activeUserMcpProfileStore = service;
    });
    return service;
  }),
);

export const getActivePersonalMcpProfile = (
  userId: UserId,
): Effect.Effect<PersonalMcpProfile | undefined, PersonalMcpSettingsError> =>
  activeUserMcpProfileStore ? activeUserMcpProfileStore.get(userId) : Effect.succeed(undefined);

export const getActiveIntegrationCredential = (
  userId: UserId,
  integrationId: PersonalMcpIntegrationId,
): Effect.Effect<string | undefined, PersonalMcpSettingsError> =>
  activeUserMcpProfileStore
    ? activeUserMcpProfileStore.getIntegrationCredential(userId, integrationId)
    : Effect.succeed(undefined);

export const resolveActiveExternalToken = (
  rawToken: string,
): Effect.Effect<ResolvedPersonalMcpToken | undefined, PersonalMcpSettingsError> =>
  activeUserMcpProfileStore
    ? activeUserMcpProfileStore.resolveExternalToken(rawToken)
    : Effect.succeed(undefined);
