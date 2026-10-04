/**
 * T3-CUSTOM(expbkt3): Durable per-user MCP integration store.
 *
 * Metadata is stored in SQLite. Raw upstream credentials are stored as
 * user/integration-namespaced ServerSecretStore entries and never returned.
 * Every read-modify-write of a profile runs under that user's lock.
 */
import {
  BIFROST_GATEWAYS,
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
import { makePerUserLock } from "./PerUserLock.ts";
import { managedToolyardIntegration, managedToolyardCredential, managedToolyardBaseUrl, hasManagedToolyardRuntime } from "../toolyard/ToolyardIntegration.ts";

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

/** Equal credentials, compared in constant time over their digests. */
const credentialsMatch = (left: string, right: string): boolean =>
  NodeCrypto.timingSafeEqual(Buffer.from(hash(left), "hex"), Buffer.from(hash(right), "hex"));

/**
 * The built-in toolyard integration every profile carries. Its credential is
 * written only by the connect flow (`ToolyardConnect.ts`), never by a client,
 * and it counts as connected only while `connectedAt` — which only that flow
 * writes — is set.
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
 * The setup toolyard replaced: any virtual-key (`x-bf-vk`) integration pointed
 * at toolyard, whatever its id, whose stored key was a toolyard key. toolyard
 * is its own bearer integration now and the Bifrost allowlist no longer names
 * it, so left alone such an entry would canonicalize to bk-toolhub and send a
 * toolyard key there. It is dropped on read and on write, secret included.
 */
export const isLegacyToolyardIntegration = (integration: {
  readonly url: string;
  readonly authMode: string;
}): boolean => integration.authMode === "x-bf-vk" && isToolyardGatewayUrl(integration.url);

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

/** A stored toolyard entry claiming a credential the connect flow never wrote. */
const isStaleToolyardCredential = (integration: PersonalMcpIntegration): boolean =>
  integration.id === TOOLYARD_MCP_INTEGRATION_ID &&
  integration.credentialConfigured &&
  integration.connectedAt === undefined;

/**
 * The integrations a profile presents: the built-in toolyard entry first
 * (the stored one, or a fresh unconnected one), then the user's own, with any
 * legacy toolyard-via-virtual-key entry removed.
 */
const presentIntegrations = (
  stored: ReadonlyArray<PersonalMcpIntegration>,
): ReadonlyArray<PersonalMcpIntegration> => {
  const canonical = stored
    .filter((integration) => !isLegacyToolyardIntegration(integration))
    .map(canonicalizePersonalMcpIntegration);
  const storedToolyard = canonical.find(
    (integration) => integration.id === TOOLYARD_MCP_INTEGRATION_ID,
  );
  const toolyard =
    storedToolyard === undefined
      ? builtInToolyardIntegration()
      : {
          ...storedToolyard,
          credentialConfigured:
            storedToolyard.credentialConfigured && storedToolyard.connectedAt !== undefined,
        };
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
  if (hasManagedToolyardRuntime() && integration.id !== TOOLYARD_MCP_INTEGRATION_ID &&
    (isToolyardGatewayUrl(integration.url) || integration.url === `${managedToolyardBaseUrl()}/mcp`)) {
    throw new Error("Toolyard uses the environment's server-owned connection. Remove the manual Toolyard integration.");
  }
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
    /** Revalidate a derived background credential without retaining its bearer secret. */
    readonly isExternalGrantActive: (
      userId: UserId,
      tokenHash: string,
    ) => Effect.Effect<boolean, PersonalMcpSettingsError>;
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
      connection: IntegrationConnection,
    ) => Effect.Effect<PersonalMcpProfile, PersonalMcpSettingsError>;
    /**
     * Forgets a credential the upstream has rejected, but only if `credential`
     * — the one the caller actually sent — is still the stored one (compared
     * under the user's lock, constant-time over hashes). A Reconnect that
     * raced an in-flight call has already replaced the secret, and that
     * rejection was for the old token: nothing happens, `retired` is false.
     * When it does retire, the secret is removed and the integration reads as
     * unconfigured (and, for toolyard, as never connected), so the client
     * connects it again on its next load.
     */
    readonly retireIntegrationCredential: (
      userId: UserId,
      integrationId: PersonalMcpIntegrationId,
      credential: string,
    ) => Effect.Effect<
      { readonly retired: boolean; readonly profile: PersonalMcpProfile },
      PersonalMcpSettingsError
    >;
  }
>()("t3/mcp/UserMcpProfileStore") {}

let activeUserMcpProfileStore: UserMcpProfileStore["Service"] | undefined;

export const layer = Layer.effect(
  UserMcpProfileStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const userLock = makePerUserLock();

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
        integrations: yield* managedToolyardIntegration(userId).pipe(
          Effect.catch(() => Effect.succeed(null)),
          Effect.map((managed) => managed === undefined ? presentIntegrations(stored.integrations) : [
            ...(managed === null ? [] : [managed]),
            ...presentIntegrations(stored.integrations).filter((entry) => entry.id !== TOOLYARD_MCP_INTEGRATION_ID &&
              !isToolyardGatewayUrl(entry.url) && entry.url !== `${managedToolyardBaseUrl()}/mcp`),
          ]),
        ),
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
     * One-time repairs applied the first time a stored profile is read: a
     * legacy toolyard-via-virtual-key entry goes, with the toolyard key filed
     * under its id; a toolyard entry claiming a credential the connect flow
     * never wrote is demoted and its stale secret removed. Both keep a wrong
     * or dead key from ever being sent again.
     */
    const healStoredProfile = Effect.fn("UserMcpProfileStore.healStoredProfile")(function* (
      userId: UserId,
      row: ProfileRow | undefined,
    ) {
      if (row === undefined) return row;
      const stored = yield* parseStoredProfile(row.profileJson);
      const legacy = stored.integrations.filter(isLegacyToolyardIntegration);
      const stale = stored.integrations.filter(isStaleToolyardCredential);
      if (legacy.length === 0 && stale.length === 0) return row;
      for (const integration of [...legacy, ...stale]) {
        yield* removeSecret(userId, integration.id);
      }
      yield* persistStored(userId, {
        externalAccessEnabled: stored.externalAccessEnabled,
        integrations: stored.integrations
          .filter((integration) => !isLegacyToolyardIntegration(integration))
          .map((integration) =>
            isStaleToolyardCredential(integration)
              ? { ...integration, credentialConfigured: false }
              : integration,
          ),
      });
      return yield* readRow(userId);
    });

    // Internal variants run without the user lock; the public service wraps
    // each in it so nested calls never contend for the same mutex.
    const getUnlocked = Effect.fn("UserMcpProfileStore.get")(function* (userId: UserId) {
      const row = yield* healStoredProfile(userId, yield* readRow(userId));
      return yield* materialize(userId, row);
    });

    const updateUnlocked = Effect.fn("UserMcpProfileStore.update")(function* (
      userId: UserId,
      input: PersonalMcpProfileUpdate,
    ) {
      const current = yield* getUnlocked(userId);
      // The built-in toolyard integration can be neither removed nor given a
      // credential by a client; a stale client still sending a legacy
      // toolyard-via-virtual-key entry loses it here.
      const requested = input.integrations
        .filter((integration) => !isLegacyToolyardIntegration(integration))
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
      return yield* getUnlocked(userId);
    });

    const setIntegrationCredentialUnlocked = Effect.fn(
      "UserMcpProfileStore.setIntegrationCredential",
    )(function* (
      userId: UserId,
      integrationId: PersonalMcpIntegrationId,
      credential: string,
      connection: IntegrationConnection,
    ) {
      const current = yield* getUnlocked(userId);
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
                connectedEmail: connection.email,
                connectedAt,
              }
            : entry,
        ),
      });
      return yield* getUnlocked(userId);
    });

    const retireIntegrationCredentialUnlocked = Effect.fn(
      "UserMcpProfileStore.retireIntegrationCredential",
    )(function* (userId: UserId, integrationId: PersonalMcpIntegrationId, credential: string) {
      const current = yield* getUnlocked(userId);
      const stored = yield* secrets
        .get(secretName(userId, integrationId))
        .pipe(Effect.mapError((cause) => fail("read-integration-secret", cause)));
      if (
        Option.isNone(stored) ||
        !credentialsMatch(textDecoder.decode(stored.value), credential)
      ) {
        return { retired: false, profile: current };
      }
      yield* removeSecret(userId, integrationId);
      yield* persistStored(userId, {
        externalAccessEnabled: current.externalAccessEnabled,
        integrations: current.integrations.map((entry) => {
          if (entry.id !== integrationId) return entry;
          const { connectedAt: _at, connectedEmail: _email, ...rest } = entry;
          return { ...rest, credentialConfigured: false };
        }),
      });
      return { retired: true, profile: yield* getUnlocked(userId) };
    });

    const rotateExternalTokenUnlocked = Effect.fn("UserMcpProfileStore.rotateExternalToken")(
      function* (userId: UserId) {
        const current = yield* getUnlocked(userId);
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
        return { profile: yield* getUnlocked(userId), token: rawToken };
      },
    );

    const revokeExternalTokenUnlocked = Effect.fn("UserMcpProfileStore.revokeExternalToken")(
      function* (userId: UserId) {
        const current = yield* getUnlocked(userId);
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
        return yield* getUnlocked(userId);
      },
    );

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
        if (integrationId === TOOLYARD_MCP_INTEGRATION_ID && hasManagedToolyardRuntime()) return yield* managedToolyardCredential(userId);
        const value = yield* secrets
          .get(secretName(userId, integrationId))
          .pipe(Effect.mapError((cause) => fail("read-integration-secret", cause)));
        return Option.isSome(value) ? textDecoder.decode(value.value) : undefined;
      },
    );

    const service = UserMcpProfileStore.of({
      get: (userId) => userLock.withLock(userId, getUnlocked(userId)),
      update: (userId, input) => userLock.withLock(userId, updateUnlocked(userId, input)),
      rotateExternalToken: (userId) =>
        userLock.withLock(userId, rotateExternalTokenUnlocked(userId)),
      revokeExternalToken: (userId) =>
        userLock.withLock(userId, revokeExternalTokenUnlocked(userId)),
      resolveExternalToken,
      isExternalGrantActive: (userId, tokenHash) =>
        Effect.gen(function* () {
          const row = yield* readRow(userId);
          if (!row?.externalTokenHash || row.externalTokenHash !== tokenHash) return false;
          return (yield* materialize(userId, row)).externalAccessEnabled;
        }),
      getIntegrationCredential,
      setIntegrationCredential: (userId, integrationId, credential, connection) =>
        userLock.withLock(
          userId,
          setIntegrationCredentialUnlocked(userId, integrationId, credential, connection),
        ),
      retireIntegrationCredential: (userId, integrationId, credential) =>
        userLock.withLock(
          userId,
          retireIntegrationCredentialUnlocked(userId, integrationId, credential),
        ),
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

/**
 * Forgets a rejected credential through the process-scoped store, if one is
 * up and `credential` is still the stored one. `true` when it was retired.
 */
export const retireActiveIntegrationCredential = (
  userId: UserId,
  integrationId: PersonalMcpIntegrationId,
  credential: string,
): Effect.Effect<boolean, PersonalMcpSettingsError> =>
  activeUserMcpProfileStore
    ? Effect.map(
        activeUserMcpProfileStore.retireIntegrationCredential(userId, integrationId, credential),
        (outcome) => outcome.retired,
      )
    : Effect.succeed(false);

export const resolveActiveExternalToken = (
  rawToken: string,
): Effect.Effect<ResolvedPersonalMcpToken | undefined, PersonalMcpSettingsError> =>
  activeUserMcpProfileStore
    ? activeUserMcpProfileStore.resolveExternalToken(rawToken)
    : Effect.succeed(undefined);

/** A revoked or rotated personal token cannot keep a derived provider credential alive. */
export const isActiveExternalGrant = (userId: UserId, tokenHash: string) =>
  activeUserMcpProfileStore
    ? activeUserMcpProfileStore
        .isExternalGrantActive(userId, tokenHash)
        .pipe(Effect.orElseSucceed(() => false))
    : Effect.succeed(false);
