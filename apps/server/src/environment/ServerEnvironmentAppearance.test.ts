// T3-CUSTOM(expbkt3): the shared host appearance (nickname, icon, colour).
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { redactServerSettingsForClient } from "../serverSettings.ts";
import * as ServerEnvironment from "./ServerEnvironment.ts";

it.layer(NodeServices.layer)("shared host appearance", (it) => {
  it.effect("advertises that the server keeps the appearance setting", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-environment-appearance-test-",
      });
      const descriptor = yield* Effect.gen(function* () {
        const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
        return yield* serverEnvironment.getDescriptor;
      }).pipe(
        Effect.provide(
          ServerEnvironment.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
      expect(descriptor.capabilities.environmentAppearance).toBe(true);
      expect(descriptor.capabilities.environmentIcon).toBe(true);
    }),
  );

  it.effect("replaces the appearance whole, so a cleared nickname stays cleared", () =>
    Effect.sync(() => {
      const named = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        environmentAppearance: { nickname: "Build box", iconId: "rocket" },
      });
      expect(named.environmentAppearance).toEqual({ nickname: "Build box", iconId: "rocket" });

      const renamed = applyServerSettingsPatch(named, {
        environmentAppearance: { iconId: "cloud", colorId: "teal" },
      });
      expect(renamed.environmentAppearance).toEqual({ iconId: "cloud", colorId: "teal" });

      const reset = applyServerSettingsPatch(renamed, { environmentAppearance: null });
      expect(reset.environmentAppearance).toBeNull();

      // An unrelated patch leaves it alone.
      const untouched = applyServerSettingsPatch(renamed, { environmentIcon: "laptop" });
      expect(untouched.environmentAppearance).toEqual({ iconId: "cloud", colorId: "teal" });
    }),
  );

  it.effect("reaches every client, including team-mode members", () =>
    Effect.sync(() => {
      // Config reads, settings streams and update replies all go through this
      // redaction; the appearance is not a secret and must survive it.
      const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
        environmentAppearance: { nickname: "Lab", colorId: "pink" },
      });
      expect(redactServerSettingsForClient(settings).environmentAppearance).toEqual({
        nickname: "Lab",
        colorId: "pink",
      });
    }),
  );
});
