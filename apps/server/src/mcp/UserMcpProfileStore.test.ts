import { assert, describe, expect, it } from "@effect/vitest";
import {
  BIFROST_MCP_URL,
  isAllowedBifrostGatewayUrl,
  isToolyardGatewayUrl,
  PersonalMcpIntegration,
  type PersonalMcpIntegrationId,
  type PersonalMcpIntegrationUpdate,
  type PersonalMcpSettingsError,
  ProviderInstanceId,
  TOOLYARD_MCP_URL,
  UserId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import createUserMcpProfilesTable from "../persistence/Migrations/042_UserMcpProfiles.ts";
import {
  canonicalizePersonalMcpIntegration,
  isLegacyToolyardBifrostIntegration,
  UserMcpProfileStore,
  layer as userMcpProfileStoreLayer,
} from "./UserMcpProfileStore.ts";

const bifrostIntegration = (url: string): PersonalMcpIntegrationUpdate => ({
  id: "bifrost",
  name: "Redirected Bifrost",
  url,
  enabled: true,
  authMode: "x-bf-vk",
  customHeaderName: "x-custom",
  credential: "virtual-key",
  providerInstanceIds: [],
  allowedTools: [],
});

it("forces Bifrost virtual-key integrations through the shared Toolhub endpoint", () => {
  expect(
    canonicalizePersonalMcpIntegration({
      id: "bifrost",
      name: "Redirected Bifrost",
      url: "https://attacker.example/mcp",
      enabled: true,
      authMode: "x-bf-vk",
      customHeaderName: "x-custom",
      credential: "virtual-key",
      providerInstanceIds: [],
      allowedTools: [],
    }),
  ).toEqual({
    id: "bifrost",
    name: "Bifrost",
    url: "https://bk-toolhub.beknown.live/mcp",
    enabled: true,
    authMode: "x-bf-vk",
    customHeaderName: "",
    credential: "virtual-key",
    providerInstanceIds: [],
    allowedTools: [],
  });
});

describe("Bifrost gateway allowlist", () => {
  it("keeps Bifrost as the only gateway", () => {
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(BIFROST_MCP_URL))).toMatchObject({
      id: "bifrost",
      name: "Bifrost",
      url: "https://bk-toolhub.beknown.live/mcp",
    });
  });

  it("no longer admits toolyard as a Bifrost gateway", () => {
    expect(isAllowedBifrostGatewayUrl(TOOLYARD_MCP_URL)).toBe(false);
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(TOOLYARD_MCP_URL))).toMatchObject({
      name: "Bifrost",
      url: BIFROST_MCP_URL,
    });
  });

  it.each([
    "https://toolyard.dev.beknown.live.evil.com/mcp",
    "https://toolyard.dev.beknown.live./mcp",
    "https://user:pass@toolyard.dev.beknown.live/mcp",
    "https://evil.com/mcp?host=toolyard.dev.beknown.live",
    "not a url",
  ])("rewrites the lookalike %s to Bifrost", (url) => {
    expect(isAllowedBifrostGatewayUrl(url)).toBe(false);
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(url))).toMatchObject({
      name: "Bifrost",
      url: BIFROST_MCP_URL,
    });
  });

  it("leaves integrations that do not carry a Bifrost virtual key untouched", () => {
    const integration: PersonalMcpIntegrationUpdate = {
      ...bifrostIntegration("https://mcp.example.com/mcp"),
      id: "example",
      name: "Example",
      authMode: "bearer",
    };
    expect(canonicalizePersonalMcpIntegration(integration)).toBe(integration);
  });
});

describe("the built-in toolyard integration", () => {
  it("pins name, URL, bearer auth and enabled state whatever a client sends", () => {
    expect(
      canonicalizePersonalMcpIntegration({
        id: "toolyard",
        name: "renamed",
        url: "https://attacker.example/mcp",
        enabled: false,
        authMode: "x-bf-vk",
        customHeaderName: "x-custom",
        credential: "pasted",
        providerInstanceIds: [ProviderInstanceId.make("codex")],
        allowedTools: ["one"],
      }),
    ).toEqual({
      id: "toolyard",
      name: "toolyard",
      url: TOOLYARD_MCP_URL,
      enabled: true,
      authMode: "bearer",
      customHeaderName: "",
      credential: "pasted",
      providerInstanceIds: ["codex"],
      allowedTools: ["one"],
    });
  });

  it.each([
    TOOLYARD_MCP_URL,
    "https://toolyard.dev.beknown.live/mcp/",
    "HTTPS://Toolyard.Dev.Beknown.Live/MCP",
    "  https://toolyard.dev.beknown.live:443/mcp  ",
  ])("recognises %s as the toolyard endpoint", (url) => {
    expect(isToolyardGatewayUrl(url)).toBe(true);
    expect(isLegacyToolyardBifrostIntegration({ id: "bifrost", url })).toBe(true);
  });

  it.each([
    "https://toolyard.dev.beknown.live/mcpx",
    "https://toolyard.dev.beknown.live:8443/mcp",
    "http://toolyard.dev.beknown.live/mcp",
    BIFROST_MCP_URL,
  ])("does not mistake %s for the toolyard endpoint", (url) => {
    expect(isToolyardGatewayUrl(url)).toBe(false);
    expect(isLegacyToolyardBifrostIntegration({ id: "bifrost", url })).toBe(false);
  });
});

// --- store behaviour against an in-memory database ---------------------------

const userId = UserId.make("user_clerk_1");
const toolyardId = "toolyard" as PersonalMcpIntegrationId;
const bifrostId = "bifrost" as PersonalMcpIntegrationId;

/** Mirrors the store's private naming so a test can seed and inspect secrets. */
const secretNameFor = (integrationId: string) =>
  `user-mcp-${NodeCrypto.createHash("sha256").update(`${userId}\0${integrationId}`, "utf8").digest("hex")}`;

const makeSecrets = () => {
  const entries = new Map<string, Uint8Array>();
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(entries.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        entries.set(name, value);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) =>
      Effect.sync(() => {
        entries.delete(name);
      }),
  });
  return { store, entries };
};

const makeStoreLayer = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  userMcpProfileStoreLayer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets)),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

const withStore = <A, E>(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  body: (
    store: UserMcpProfileStore["Service"],
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    yield* createUserMcpProfilesTable;
    const store = yield* UserMcpProfileStore;
    const sql = yield* SqlClient.SqlClient;
    return yield* body(store, sql);
  }).pipe(Effect.provide(makeStoreLayer(secrets)));

/** The shape `UserMcpProfileStore` persists in `profile_json`. */
const StoredProfileJson = Schema.fromJsonString(
  Schema.Struct({
    externalAccessEnabled: Schema.Boolean,
    integrations: Schema.Array(PersonalMcpIntegration),
  }),
);

const readStoredJson = (sql: SqlClient.SqlClient) =>
  sql<{ readonly profileJson: string }>`
    SELECT profile_json AS "profileJson" FROM user_mcp_profiles WHERE user_id = ${userId}
  `.pipe(
    Effect.flatMap((rows) =>
      Schema.decodeUnknownEffect(StoredProfileJson)(rows[0]?.profileJson ?? ""),
    ),
  );

describe("UserMcpProfileStore", () => {
  it.effect("presents an unconnected built-in toolyard integration on a fresh profile", () => {
    const { store: secrets } = makeSecrets();
    return withStore(secrets, (store) =>
      Effect.gen(function* () {
        const profile = yield* store.get(userId);
        expect(profile.integrations).toEqual([
          {
            id: "toolyard",
            name: "toolyard",
            url: TOOLYARD_MCP_URL,
            enabled: true,
            authMode: "bearer",
            customHeaderName: "",
            credentialConfigured: false,
            providerInstanceIds: [],
            allowedTools: [],
          },
        ]);
      }),
    );
  });

  it.effect("stores a server-obtained credential and records who connected", () => {
    const { store: secrets, entries } = makeSecrets();
    return withStore(secrets, (store) =>
      Effect.gen(function* () {
        const profile = yield* store.setIntegrationCredential(userId, toolyardId, "ty_first", {
          email: "tushar@beknown.work",
        });
        const toolyard = profile.integrations.find((entry) => entry.id === "toolyard");
        expect(toolyard).toMatchObject({
          credentialConfigured: true,
          connectedEmail: "tushar@beknown.work",
          authMode: "bearer",
          url: TOOLYARD_MCP_URL,
        });
        assert.isString(toolyard?.connectedAt);
        expect(Number.isNaN(Date.parse(toolyard!.connectedAt!))).toBe(false);
        // Same secret name `update` would use, so the proxy reads it back unchanged.
        expect(yield* store.getIntegrationCredential(userId, toolyardId)).toBe("ty_first");
        expect(entries.has(secretNameFor("toolyard"))).toBe(true);

        // A reconnect rotates: the new token replaces the old one in place.
        yield* store.setIntegrationCredential(userId, toolyardId, "ty_second", {
          email: "tushar@beknown.work",
        });
        expect(yield* store.getIntegrationCredential(userId, toolyardId)).toBe("ty_second");
        expect(entries.size).toBe(1);
      }),
    );
  });

  it.effect("refuses a credential for an integration the profile does not carry", () => {
    const { store: secrets, entries } = makeSecrets();
    return withStore(secrets, (store) =>
      Effect.gen(function* () {
        const error: PersonalMcpSettingsError = yield* store
          .setIntegrationCredential(userId, "ghost" as PersonalMcpIntegrationId, "secret")
          .pipe(Effect.flip);
        expect(error.operation).toBe("set-integration-credential");
        expect(entries.size).toBe(0);
      }),
    );
  });

  it.effect(
    "keeps toolyard through client updates and ignores a pasted toolyard credential",
    () => {
      const { store: secrets, entries } = makeSecrets();
      return withStore(secrets, (store) =>
        Effect.gen(function* () {
          yield* store.setIntegrationCredential(userId, toolyardId, "ty_token", { email: "a@b.c" });

          // A client that tampers with the built-in entry and pastes a key.
          const tampered = yield* store.update(userId, {
            externalAccessEnabled: false,
            integrations: [
              {
                id: "toolyard",
                name: "mine",
                url: "https://attacker.example/mcp",
                enabled: false,
                authMode: "x-api-key",
                customHeaderName: "",
                credential: "pasted-key",
                providerInstanceIds: [],
                allowedTools: [],
              },
            ],
          });
          expect(tampered.integrations).toHaveLength(1);
          expect(tampered.integrations[0]).toMatchObject({
            id: "toolyard",
            name: "toolyard",
            url: TOOLYARD_MCP_URL,
            enabled: true,
            authMode: "bearer",
            credentialConfigured: true,
            connectedEmail: "a@b.c",
          });
          expect(yield* store.getIntegrationCredential(userId, toolyardId)).toBe("ty_token");

          // A client that omits the built-in entry altogether (the old UI's remove button).
          const omitted = yield* store.update(userId, {
            externalAccessEnabled: false,
            integrations: [
              {
                id: "bifrost",
                name: "Bifrost",
                url: BIFROST_MCP_URL,
                enabled: true,
                authMode: "x-bf-vk",
                customHeaderName: "",
                credential: "vk",
                providerInstanceIds: [],
                allowedTools: [],
              },
            ],
          });
          expect(omitted.integrations.map((entry) => entry.id)).toEqual(["toolyard", "bifrost"]);
          expect(omitted.integrations[0]).toMatchObject({
            credentialConfigured: true,
            connectedEmail: "a@b.c",
          });
          expect(yield* store.getIntegrationCredential(userId, toolyardId)).toBe("ty_token");
          expect(yield* store.getIntegrationCredential(userId, bifrostId)).toBe("vk");
          expect(entries.size).toBe(2);
        }),
      );
    },
  );

  it.effect("retires the old toolyard-via-Bifrost entry together with its secret on read", () => {
    const { store: secrets, entries } = makeSecrets();
    entries.set(
      secretNameFor("bifrost"),
      new TextEncoder().encode("toolyard-key-filed-as-bifrost"),
    );
    return withStore(secrets, (store, sql) =>
      Effect.gen(function* () {
        const legacyJson = yield* Schema.encodeEffect(StoredProfileJson)({
          externalAccessEnabled: true,
          integrations: [
            {
              id: "bifrost",
              name: "Bifrost pointed at toolyard",
              url: TOOLYARD_MCP_URL,
              enabled: true,
              authMode: "x-bf-vk",
              customHeaderName: "",
              credentialConfigured: true,
              providerInstanceIds: [],
              allowedTools: [],
            },
            {
              id: "notes",
              name: "Notes",
              url: "https://notes.example/mcp",
              enabled: true,
              authMode: "bearer",
              customHeaderName: "",
              credentialConfigured: false,
              providerInstanceIds: [],
              allowedTools: [],
            },
          ],
        });
        yield* sql`
          INSERT INTO user_mcp_profiles (user_id, profile_json, updated_at)
          VALUES (${userId}, ${legacyJson}, ${"2026-09-01T00:00:00.000Z"})
        `;

        const profile = yield* store.get(userId);
        expect(profile.integrations.map((entry) => entry.id)).toEqual(["toolyard", "notes"]);
        expect(profile.externalAccessEnabled).toBe(true);
        // The key is gone, so nothing can ever send it to bk-toolhub.
        expect(entries.has(secretNameFor("bifrost"))).toBe(false);
        expect(yield* store.getIntegrationCredential(userId, bifrostId)).toBeUndefined();
        // And the row itself was cleaned, not just the view.
        const stored = yield* readStoredJson(sql);
        expect(stored.integrations.map((entry) => entry.id)).toEqual(["notes"]);
      }),
    );
  });

  it.effect("drops a legacy toolyard-via-Bifrost entry a stale client still sends", () => {
    const { store: secrets, entries } = makeSecrets();
    return withStore(secrets, (store, sql) =>
      Effect.gen(function* () {
        const profile = yield* store.update(userId, {
          externalAccessEnabled: false,
          integrations: [bifrostIntegration(TOOLYARD_MCP_URL)],
        });
        expect(profile.integrations.map((entry) => entry.id)).toEqual(["toolyard"]);
        expect(entries.size).toBe(0);
        const stored = yield* readStoredJson(sql);
        expect(stored.integrations.map((entry) => entry.id)).toEqual(["toolyard"]);
      }),
    );
  });

  it.effect("still lets a user keep a real Bifrost (bk-toolhub) integration alongside", () => {
    const { store: secrets } = makeSecrets();
    return withStore(secrets, (store) =>
      Effect.gen(function* () {
        const profile = yield* store.update(userId, {
          externalAccessEnabled: false,
          integrations: [bifrostIntegration(BIFROST_MCP_URL)],
        });
        expect(profile.integrations.map((entry) => entry.id)).toEqual(["toolyard", "bifrost"]);
        expect(profile.integrations[1]).toMatchObject({
          url: BIFROST_MCP_URL,
          credentialConfigured: true,
        });
      }),
    );
  });
});
