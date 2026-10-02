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
  isLegacyToolyardIntegration,
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
    expect(isLegacyToolyardIntegration({ url, authMode: "x-bf-vk" })).toBe(true);
  });

  it.each([
    "https://toolyard.dev.beknown.live/mcpx",
    "https://toolyard.dev.beknown.live:8443/mcp",
    "http://toolyard.dev.beknown.live/mcp",
    BIFROST_MCP_URL,
  ])("does not mistake %s for the toolyard endpoint", (url) => {
    expect(isToolyardGatewayUrl(url)).toBe(false);
    expect(isLegacyToolyardIntegration({ url, authMode: "x-bf-vk" })).toBe(false);
  });

  it("counts only a virtual-key entry at toolyard as legacy, whatever its id", () => {
    expect(isLegacyToolyardIntegration({ url: TOOLYARD_MCP_URL, authMode: "x-bf-vk" })).toBe(true);
    expect(isLegacyToolyardIntegration({ url: TOOLYARD_MCP_URL, authMode: "bearer" })).toBe(false);
    expect(isLegacyToolyardIntegration({ url: TOOLYARD_MCP_URL, authMode: "x-api-key" })).toBe(
      false,
    );
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

const seedStoredProfile = (
  sql: SqlClient.SqlClient,
  integrations: ReadonlyArray<PersonalMcpIntegration>,
) =>
  Effect.gen(function* () {
    const json = yield* Schema.encodeEffect(StoredProfileJson)({
      externalAccessEnabled: true,
      integrations,
    });
    yield* sql`
      INSERT INTO user_mcp_profiles (user_id, profile_json, updated_at)
      VALUES (${userId}, ${json}, ${"2026-09-01T00:00:00.000Z"})
    `;
  });

const notesIntegration: PersonalMcpIntegration = {
  id: "notes",
  name: "Notes",
  url: "https://notes.example/mcp",
  enabled: true,
  authMode: "bearer",
  customHeaderName: "",
  credentialConfigured: false,
  providerInstanceIds: [],
  allowedTools: [],
};

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

  it.effect("retires a rejected credential so the client connects again", () => {
    const { store: secrets, entries } = makeSecrets();
    return withStore(secrets, (store, sql) =>
      Effect.gen(function* () {
        yield* store.setIntegrationCredential(userId, toolyardId, "ty_dead", { email: "a@b.c" });

        const retired = yield* store.retireIntegrationCredential(userId, toolyardId);
        expect(retired.integrations[0]).toEqual({
          id: "toolyard",
          name: "toolyard",
          url: TOOLYARD_MCP_URL,
          enabled: true,
          authMode: "bearer",
          customHeaderName: "",
          credentialConfigured: false,
          providerInstanceIds: [],
          allowedTools: [],
        });
        expect(entries.has(secretNameFor("toolyard"))).toBe(false);
        expect(yield* store.getIntegrationCredential(userId, toolyardId)).toBeUndefined();
        const stored = yield* readStoredJson(sql);
        expect(stored.integrations[0]).toMatchObject({
          id: "toolyard",
          credentialConfigured: false,
        });
        expect(stored.integrations[0]).not.toHaveProperty("connectedAt");

        // And a fresh connect brings it back.
        const reconnected = yield* store.setIntegrationCredential(userId, toolyardId, "ty_new", {
          email: "a@b.c",
        });
        expect(reconnected.integrations[0]).toMatchObject({
          credentialConfigured: true,
          connectedEmail: "a@b.c",
        });
        expect(yield* store.getIntegrationCredential(userId, toolyardId)).toBe("ty_new");
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
        yield* seedStoredProfile(sql, [
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
          notesIntegration,
        ]);

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

  it.effect("retires a toolyard virtual-key entry under any id, with that id's secret", () => {
    const { store: secrets, entries } = makeSecrets();
    entries.set(secretNameFor("ty"), new TextEncoder().encode("toolyard-key-filed-as-ty"));
    entries.set(secretNameFor("notes"), new TextEncoder().encode("notes-token"));
    return withStore(secrets, (store, sql) =>
      Effect.gen(function* () {
        yield* seedStoredProfile(sql, [
          {
            id: "ty",
            name: "toolyard via virtual key",
            url: "https://toolyard.dev.beknown.live/mcp/",
            enabled: true,
            authMode: "x-bf-vk",
            customHeaderName: "",
            credentialConfigured: true,
            providerInstanceIds: [],
            allowedTools: [],
          },
          { ...notesIntegration, credentialConfigured: true },
        ]);

        const profile = yield* store.get(userId);
        expect(profile.integrations.map((entry) => entry.id)).toEqual(["toolyard", "notes"]);
        expect(entries.has(secretNameFor("ty"))).toBe(false);
        // Unrelated secrets stay.
        expect(
          yield* store.getIntegrationCredential(userId, "notes" as PersonalMcpIntegrationId),
        ).toBe("notes-token");
        const stored = yield* readStoredJson(sql);
        expect(stored.integrations.map((entry) => entry.id)).toEqual(["notes"]);
      }),
    );
  });

  it.effect(
    "demotes a hand-made toolyard entry whose credential the connect flow never wrote",
    () => {
      const { store: secrets, entries } = makeSecrets();
      entries.set(secretNameFor("toolyard"), new TextEncoder().encode("stale-bearer"));
      return withStore(secrets, (store, sql) =>
        Effect.gen(function* () {
          yield* seedStoredProfile(sql, [
            {
              id: "toolyard",
              name: "mine",
              url: "https://old.example/mcp",
              enabled: true,
              authMode: "bearer",
              customHeaderName: "",
              credentialConfigured: true,
              providerInstanceIds: [],
              allowedTools: [],
            },
          ]);

          const profile = yield* store.get(userId);
          expect(profile.integrations).toHaveLength(1);
          expect(profile.integrations[0]).toMatchObject({
            id: "toolyard",
            name: "toolyard",
            url: TOOLYARD_MCP_URL,
            authMode: "bearer",
            credentialConfigured: false,
          });
          // The stale secret is gone and the row no longer claims a credential,
          // so auto-connect runs on the next load and nothing sends the old bearer.
          expect(entries.has(secretNameFor("toolyard"))).toBe(false);
          const stored = yield* readStoredJson(sql);
          expect(stored.integrations[0]).toMatchObject({
            id: "toolyard",
            credentialConfigured: false,
          });
        }),
      );
    },
  );

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

  it.effect("keeps one user's concurrent writes consistent", () => {
    const { store: secrets, entries } = makeSecrets();
    return withStore(secrets, (store) =>
      Effect.gen(function* () {
        const bifrostUpdate = (credential: string) =>
          store.update(userId, {
            externalAccessEnabled: true,
            integrations: [{ ...bifrostIntegration(BIFROST_MCP_URL), credential }],
          });
        yield* Effect.all(
          [
            store.setIntegrationCredential(userId, toolyardId, "ty_a", { email: "a@b.c" }),
            bifrostUpdate("vk_1"),
            store.setIntegrationCredential(userId, toolyardId, "ty_b", { email: "a@b.c" }),
            bifrostUpdate("vk_2"),
            store.get(userId),
            store.setIntegrationCredential(userId, toolyardId, "ty_c", { email: "a@b.c" }),
            bifrostUpdate("vk_3"),
          ],
          { concurrency: "unbounded" },
        );

        const profile = yield* store.get(userId);
        // Every write landed on top of the previous one: nothing was lost or doubled.
        expect(profile.integrations.map((entry) => entry.id)).toEqual(["toolyard", "bifrost"]);
        expect(profile.integrations[0]).toMatchObject({
          credentialConfigured: true,
          connectedEmail: "a@b.c",
        });
        expect(profile.integrations[1]).toMatchObject({ credentialConfigured: true });
        expect(profile.externalAccessEnabled).toBe(true);
        expect(entries.size).toBe(2);
        expect(["ty_a", "ty_b", "ty_c"]).toContain(
          yield* store.getIntegrationCredential(userId, toolyardId),
        );
        expect(["vk_1", "vk_2", "vk_3"]).toContain(
          yield* store.getIntegrationCredential(userId, bifrostId),
        );
      }),
    );
  });
});
