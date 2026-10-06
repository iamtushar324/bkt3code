// T3-CUSTOM(expbkt3): the deprecated host-wide thread defaults fold into
// upstream's keys once, on load.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import { layerMemory as SqlitePersistenceMemory } from "./persistence/Sqlite.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const decodeServerSettings = Schema.decodeUnknownEffect(ServerSettings);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJsonRecord = Schema.decodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const makeServerSettingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-thread-defaults-test-",
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const forkModel = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
  options: [
    { id: "effort", value: "max" },
    { id: "contextWindow", value: "1m" },
  ],
};

const readPersisted = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
  const json = decodeJsonRecord(raw);
  return { json, settings: yield* decodeServerSettings(json) };
});

it.effect("folds the fork's thread model and access defaults into upstream's keys", () =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    yield* fileSystem.writeFileString(
      serverConfig.settingsPath,
      encodeJson({
        defaultThreadModelSelection: forkModel,
        defaultThreadRuntimeMode: "approval-required",
      }),
    );

    const settings = yield* serverSettings.getSettings;
    // Options (effort, context size) travel with the model.
    assert.deepEqual(settings.defaultModelSelection, forkModel);
    assert.equal(settings.defaultRuntimeMode, "approval-required");

    // The file now holds only the upstream keys, so the next load has nothing
    // left to fold and a later reset of the upstream key sticks.
    const { json, settings: persisted } = yield* readPersisted;
    assert.deepEqual(persisted.defaultModelSelection, forkModel);
    assert.equal(persisted.defaultRuntimeMode, "approval-required");
    assert.isFalse(Object.hasOwn(json, "defaultThreadModelSelection"));
    assert.isFalse(Object.hasOwn(json, "defaultThreadRuntimeMode"));
  }).pipe(Effect.provide(makeServerSettingsLayer())),
);

it.effect("keeps the upstream key when both the fork and upstream keys are present", () =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const upstreamModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-astra" };
    yield* fileSystem.writeFileString(
      serverConfig.settingsPath,
      encodeJson({
        defaultModelSelection: upstreamModel,
        defaultRuntimeMode: "auto-accept-edits",
        defaultThreadModelSelection: forkModel,
        defaultThreadRuntimeMode: "approval-required",
      }),
    );

    const settings = yield* serverSettings.getSettings;
    assert.deepEqual(settings.defaultModelSelection, upstreamModel);
    assert.equal(settings.defaultRuntimeMode, "auto-accept-edits");
    const { json } = yield* readPersisted;
    assert.isFalse(Object.hasOwn(json, "defaultThreadModelSelection"));
    assert.isFalse(Object.hasOwn(json, "defaultThreadRuntimeMode"));
  }).pipe(Effect.provide(makeServerSettingsLayer())),
);

it.effect("leaves a file without the fork keys alone", () =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const original = encodeJson({ defaultRuntimeMode: "approval-required" });
    yield* fileSystem.writeFileString(serverConfig.settingsPath, original);

    const settings = yield* serverSettings.getSettings;
    assert.isNull(settings.defaultModelSelection);
    assert.equal(settings.defaultRuntimeMode, "approval-required");
    // Nothing to fold, nothing written: the user's file is byte-identical.
    assert.equal(yield* fileSystem.readFileString(serverConfig.settingsPath), original);
  }).pipe(Effect.provide(makeServerSettingsLayer())),
);

it.effect("lends the fork's effort and context to an upstream entry naming the same model", () =>
  Effect.gen(function* () {
    // The shape found on the live stage-dev and bkt3-dev settings.json: the
    // settings UI saved the model without options, the fork key kept them.
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const options = [
      { id: "effort", value: "medium" },
      { id: "contextWindow", value: "200k" },
    ];
    yield* fileSystem.writeFileString(
      serverConfig.settingsPath,
      encodeJson({
        defaultModelSelection: { instanceId, model: "claude-opus-5-5" },
        defaultThreadModelSelection: { instanceId, model: "claude-opus-5-5", options },
      }),
    );

    const settings = yield* serverSettings.getSettings;
    assert.deepEqual(settings.defaultModelSelection, {
      instanceId,
      model: "claude-opus-5-5",
      options,
    });
    const { json, settings: persisted } = yield* readPersisted;
    assert.deepEqual(persisted.defaultModelSelection?.options, options);
    assert.isFalse(Object.hasOwn(json, "defaultThreadModelSelection"));
  }).pipe(Effect.provide(makeServerSettingsLayer())),
);

it.effect("keeps upstream's options when the fork names the same model with other options", () =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const upstreamOptions = [{ id: "effort", value: "high" }];
    yield* fileSystem.writeFileString(
      serverConfig.settingsPath,
      encodeJson({
        defaultModelSelection: { instanceId, model: "claude-opus-5-5", options: upstreamOptions },
        defaultThreadModelSelection: {
          instanceId,
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "low" }],
        },
      }),
    );

    const settings = yield* serverSettings.getSettings;
    assert.deepEqual(settings.defaultModelSelection?.options, upstreamOptions);
  }).pipe(Effect.provide(makeServerSettingsLayer())),
);

it.effect("maps the deprecated thread-default patch keys onto upstream's keys", () =>
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;

    // A full deprecated model patch (what t3_update_server_settings sends).
    let settings = yield* serverSettings.updateSettings({
      defaultThreadModelSelection: forkModel,
      defaultThreadRuntimeMode: "approval-required",
    });
    assert.deepEqual(settings.defaultModelSelection, forkModel);
    assert.equal(settings.defaultRuntimeMode, "approval-required");
    const { json } = yield* readPersisted;
    assert.isFalse(Object.hasOwn(json, "defaultThreadModelSelection"));
    assert.isFalse(Object.hasOwn(json, "defaultThreadRuntimeMode"));
    assert.isTrue(Object.hasOwn(json, "defaultModelSelection"));

    // A partial deprecated patch completes from the current default.
    settings = yield* serverSettings.updateSettings({
      defaultThreadModelSelection: { model: "claude-sonnet-5" },
    });
    assert.deepEqual(settings.defaultModelSelection, { ...forkModel, model: "claude-sonnet-5" });

    // The upstream key in the same patch wins over the deprecated one.
    settings = yield* serverSettings.updateSettings({
      defaultRuntimeMode: "auto",
      defaultThreadRuntimeMode: "full-access",
    });
    assert.equal(settings.defaultRuntimeMode, "auto");
  }).pipe(Effect.provide(makeServerSettingsLayer())),
);
