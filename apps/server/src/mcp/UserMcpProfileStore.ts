/**
 * T3-CUSTOM(expbkt3): Durable per-user MCP integration store.
 *
 * Metadata is stored in SQLite. Raw upstream credentials are stored as
 * user/integration-namespaced ServerSecretStore entries and never returned.
 */
import {
  BIFROST_GATEWAYS,
  BIFROST_MCP_INTEGRATION_ID,
  isToolyardGatewayUrl,
  PersonalMcpProfile,
  type PersonalMcpProfileUpdate,
  PersonalMcpSettingsError,
  PersonalMcpIntegration,
  type PersonalMcpIntegrationId,
  type PersonalMcpIntegrationUpdate,
  resolveBifrostGateway,
  TOOLYARD_MCP_INTEGRATION_ID,
  TOOLYARD_MCP_INTEGRATION_NAME,
  TOOLYARD_MCP_URL,
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

/**
 * The built-in toolyard integration every profile carries. Its credential is
 * written only by the connect flow (`ToolyardConnect.ts`), never by a client.
 */
export const builtInToolyardIntegration = (): PersonalMcpIntegration => ({
  id: TOOLYARD_MCP_INTEGRATION_ID,
  name: TOOLYARD_MCP_INTEGRATION_NAME,
  url: TOOLYARD_MCP_URL,
  enabled: true,
  authMode: "bearer",
  customHeaderName: "",
  credentialConfigured: false,
  providerInstanceIds: [],
  allowedTools: [],
});

/**
 * The setup toolyard replaced: a `bifrost` integration pointed at toolyard,
 * whose stored virtual key was a toolyard key. toolyard is its own integration
 * now and the Bifrost allowlist no longer names it, so left alone this entry
 * would canonicalize to bk-toolhub and send a toolyard key there. It is
 * dropped on read and on write, secret included.
 */
export const isLegacyToolyardBifrostIntegration = (integration: {
  readonly id: string;
  readonly url: string;
}): boolean =>
  integration.id === BIFROST_MCP_INTEGRATION_ID && isToolyardGatewayUrl(integration.url);

/**
 * Pins what a client may not change. The built-in `toolyard` integration keeps
 * its name, URL, bearer auth and enabled state; every `x-bf-vk` integration is
 * pinned to an allowlisted Bifrost gateway (an allowlisted URL is kept in
 * canonical form, anything else falls back to Bifrost). Applied on write and
 * on every read.
 */
export const canonicalizePersonalMcpIntegration = <
  T extends PersonalMcpProfileUpdate["integrations"][number] | PersonalMcpIntegration,
>(
  integration: T,
): T => {
  if (integration.id === TOOLYARD_MCP_INTEGRATION_ID) {
    return {
      ...integration,
      name: TOOLYARD_MCP_INTEGRATION_NAME,
      url: TOOLYARD_MCP_URL,
      enabled: true,
      authMode: "bearer",
      customHeaderName: "",
    };
  }
  if (integration.authMode !== "x-bf-vk") return integration;
  const gateway = resolveBifrostGateway(integration.url) ?? BIFROST_GATEWAYS[0];
  return {
    ...integration,
    name: gateway.integrationName,
    url: gateway.url,
    authMode: "x-bf-vk",
    customHeaderName: "",
  };
};

/**
 * The integrations a profile presents: the built-in toolyard entry first
 * (the stored one, or a fresh unconnected one), then the user's own, with any
 * legacy toolyard-via-Bifrost entry removed.
 */
const presentIntegrations = (
  stored: ReadonlyArray<PersonalMcpIntegration>,
): ReadonlyArray<PersonalMcpIntegration> => {
  const canonical = stored
    .filter((integration) => !isLegacyToolyardBifrostIntegration(integration))
    .map(canonicalizePersonalMcpIntegration);
  const toolyard =
    canonical.find((integration) => integration.id === TOOLYARD_MCP_INTEGRATION_ID) ??
    builtInToolyardIntegration();
  return [
    toolyard,
    ...canonical.filter((integration) => integration.id !== TOOLYARD_MCP_INTEGRATION_ID),
  ];
};

const toIntegrationUpdate = (
  integration: PersonalMcpIntegration,
): PersonalMcpIntegrationUpdate => ({
  id: integration.id,
  name: integration.name,
  url: integration.url,
  enabled: integration.enabled,
  authMode: integration.authMode,
  customHeaderName: integration.customHeaderName,
  providerInstanceIds: integration.providerInstanceIds,
  allowedTools: integration.allowedTools,
});

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

/** Who the server connected an integration as; stamped next to the credential. */
export interface IntegrationConnection {
  readonly email: string;
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
    /**
     * Stores a credential the server obtained itself (the toolyard connect
     * flow) for an integration the profile already carries, marks it
     * configured, and records the connection when one is given.
     */
    readonly setIntegrationCredential: (
      userId: UserId,
      integrationId: PersonalMcpIntegrationId,
      credential: string,
      connection?: IntegrationConnection,
    ) => Effect.Effect<PersonalMcpProfile, PersonalMcpSettingsError>;
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
        integrations: presentIntegrations(stored.integrations),
        updatedAt: row?.updatedAt ?? now,
      });
    });

    const removeSecret = Effect.fn("UserMcpProfileStore.removeSecret")(function* (
      userId: UserId,
      integrationId: PersonalMcpIntegrationId,
    ) {
      yield* secrets
        .remove(secretName(userId, integrationId))
        .pipe(Effect.mapError((cause) => fail("remove-integration-secret", cause)));
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

    /**
     * A stored legacy toolyard-via-Bifrost entry is retired the first time the
     * profile is read: its secret (a toolyard key filed under `bifrost`) goes
     * with it, so no later write can send that key to bk-toolhub.
     */
    const retireLegacyToolyardBifrost = Effect.fn(
      "UserMcpProfileStore.retireLegacyToolyardBifrost",
    )(function* (userId: UserId, row: ProfileRow | undefined) {
      if (row === undefined) return row;
      const stored = yield* parseStoredProfile(row.profileJson);
      if (!stored.integrations.some(isLegacyToolyardBifrostIntegration)) return row;
      yield* removeSecret(userId, BIFROST_MCP_INTEGRATION_ID);
      yield* persistStored(userId, {
        externalAccessEnabled: stored.externalAccessEnabled,
        integrations: stored.integrations.filter(
          (integration) => !isLegacyToolyardBifrostIntegration(integration),
        ),
      });
      return yield* readRow(userId);
    });

    const get = Effect.fn("UserMcpProfileStore.get")(function* (userId: UserId) {
      const row = yield* retireLegacyToolyardBifrost(userId, yield* readRow(userId));
      return yield* materialize(userId, row);
    });

    const update = Effect.fn("UserMcpProfileStore.update")(function* (
      userId: UserId,
      input: PersonalMcpProfileUpdate,
    ) {
      const current = yield* get(userId);
      // The built-in toolyard integration can be neither removed nor given a
      // credential by a client; a stale client still sending the legacy
      // toolyard-via-Bifrost entry loses it here.
      const requested = input.integrations
        .filter((integration) => !isLegacyToolyardBifrostIntegration(integration))
        .map((integration): PersonalMcpIntegrationUpdate => {
          if (integration.id !== TOOLYARD_MCP_INTEGRATION_ID) return integration;
          const { credential: _ignored, ...rest } = integration;
          return rest;
        });
      const currentToolyard =
        current.integrations.find(
          (integration) => integration.id === TOOLYARD_MCP_INTEGRATION_ID,
        ) ?? builtInToolyardIntegration();
      const withToolyard = requested.some(
        (integration) => integration.id === TOOLYARD_MCP_INTEGRATION_ID,
      )
        ? requested
        : [...requested, toIntegrationUpdate(currentToolyard)];
      const canonicalIntegrations = withToolyard.map(canonicalizePersonalMcpIntegration);
      yield* Effect.try({
        try: () => canonicalIntegrations.forEach(validateIntegration),
        catch: (cause) => fail("validate-integration", cause),
      });
      const currentById = new Map(current.integrations.map((entry) => [entry.id, entry]));
      const nextIds = new Set(canonicalIntegrations.map((entry) => entry.id));

      for (const removed of current.integrations) {
        if (!nextIds.has(removed.id)) {
          yield* removeSecret(userId, removed.id);
        }
      }

      const integrations: PersonalMcpIntegration[] = [];
      for (const integration of canonicalIntegrations) {
        const existing = currentById.get(integration.id);
        let credentialConfigured = existing?.credentialConfigured ?? false;
        if (integration.credential !== undefined) {
          if (integration.credential.length === 0) {
            yield* removeSecret(userId, integration.id);
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
          // Connection metadata is the server's; a client update carries none.
          ...(existing?.connectedEmail === undefined
            ? {}
            : { connectedEmail: existing.connectedEmail }),
          ...(existing?.connectedAt === undefined ? {} : { connectedAt: existing.connectedAt }),
        });
      }

      yield* persistStored(userId, {
        externalAccessEnabled: input.externalAccessEnabled,
        integrations,
      });
      return yield* get(userId);
    });

    const setIntegrationCredential = Effect.fn("UserMcpProfileStore.setIntegrationCredential")(
      function* (
        userId: UserId,
        integrationId: PersonalMcpIntegrationId,
        credential: string,
        connection?: IntegrationConnection,
      ) {
        const current = yield* get(userId);
        const target = current.integrations.find((entry) => entry.id === integrationId);
        if (target === undefined) {
          return yield* fail(
            "set-integration-credential",
            new Error(`Integration '${integrationId}' is not configured.`),
          );
        }
        if (credential.length === 0) {
          return yield* fail(
            "set-integration-credential",
            new Error(`Integration '${integrationId}' was given an empty credential.`),
          );
        }
        yield* secrets
          .set(secretName(userId, integrationId), textEncoder.encode(credential))
          .pipe(Effect.mapError((cause) => fail("write-integration-secret", cause)));
        const connectedAt = yield* nowIso;
        yield* persistStored(userId, {
          externalAccessEnabled: current.externalAccessEnabled,
          integrations: current.integrations.map((entry) =>
            entry.id === integrationId
              ? {
                  ...entry,
                  credentialConfigured: true,
                  ...(connection === undefined
                    ? {}
                    : { connectedEmail: connection.email, connectedAt }),
                }
              : entry,
          ),
        });
        return yield* get(userId);
      },
    );

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
      setIntegrationCredential,
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
