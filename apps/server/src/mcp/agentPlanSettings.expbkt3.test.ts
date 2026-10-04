import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const decodeSettings = Schema.decodeUnknownEffect(ServerSettings);
const decodePatch = Schema.decodeUnknownEffect(ServerSettingsPatch);
const decodeSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const settingsLayer = () =>
  ServerSettingsModule.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-agent-plan-settings-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("saved agent plan policy", (it) => {
  it.effect("disables the tool for existing settings without the new field", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({ experimental: {} });
      assert.equal(settings.experimental.agentPlanSubmissionEnabled, false);
    }),
  );

  it.effect("persists disabling and enabling across service reloads", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsModule.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const initial = yield* settings.getSettings;
      yield* settings.updateSettings({
        experimental: { agentPlanSubmissionEnabled: true },
      });
      const patch = yield* decodePatch({
        experimental: { agentPlanSubmissionEnabled: false },
      });
      const disabled = yield* settings.updateSettings(patch);
      assert.equal(disabled.experimental.agentPlanSubmissionEnabled, false);
      assert.deepEqual(disabled.experimental.externalMcp, initial.experimental.externalMcp);
      const raw = yield* fs.readFileString(config.settingsPath);
      assert.equal((yield* decodeSettingsJson(raw)).experimental.agentPlanSubmissionEnabled, false);
      const reload = Effect.gen(function* () {
        const fresh = yield* ServerSettingsModule.ServerSettingsService;
        return yield* fresh.getSettings;
      }).pipe(
        Effect.provide(
          Layer.fresh(ServerSettingsModule.layer).pipe(Layer.provide(ServerSecretStore.layer)),
        ),
      );
      assert.equal((yield* reload).experimental.agentPlanSubmissionEnabled, false);
      const enabled = yield* settings.updateSettings({
        experimental: { agentPlanSubmissionEnabled: true },
      });
      assert.equal(enabled.experimental.agentPlanSubmissionEnabled, true);
      assert.equal((yield* reload).experimental.agentPlanSubmissionEnabled, true);
    }).pipe(Effect.provide(settingsLayer())),
  );
});
