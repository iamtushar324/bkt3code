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
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
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
