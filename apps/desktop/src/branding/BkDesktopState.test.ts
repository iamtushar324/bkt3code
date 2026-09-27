import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import { BK_RUNTIME_BRANDS, type BkRuntimeBrand } from "./BkBrand.ts";

const defaultEnvironmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/Applications/BK T3 Code.app/Contents/Resources/app.asar",
  isPackaged: true,
  resourcesPath: "/Applications/BK T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  runtimeBrand: BkRuntimeBrand,
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultEnvironmentInput,
    ...overrides,
    runtimeBrand,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const serverExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 4888,
    bindHost: "0.0.0.0",
    httpBaseUrl: new URL("http://127.0.0.1:4888"),
    tailscaleServeEnabled: true,
    tailscaleServePort: 8443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.succeed([]),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const makeBackendLayer = (
  runtimeBrand: BkRuntimeBrand,
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
) =>
  DesktopBackendConfiguration.layer.pipe(
    Layer.provideMerge(serverExposureLayer),
    Layer.provideMerge(DesktopAppSettings.layerTest()),
    Layer.provideMerge(DesktopWslEnvironment.layerTest()),
    Layer.provideMerge(DesktopWslServerTree.layerTest()),
    Layer.provideMerge(makeEnvironmentLayer(runtimeBrand, env, overrides)),
  );

const resolvePrimary = (
  runtimeBrand: BkRuntimeBrand,
  env: Readonly<Record<string, string | undefined>> = {},
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
) =>
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
    const primary = yield* configuration.resolvePrimary;

    assert.equal(primary.bootstrap.t3Home, environment.baseDir);
    const stateDirectory = environment.isDevelopment ? "dev" : "userdata";
    assert.equal(environment.stateDir, `${environment.baseDir}/${stateDirectory}`);
    assert.equal(environment.serverSettingsPath, `${environment.stateDir}/settings.json`);
    assert.equal(environment.logDir, `${environment.stateDir}/logs`);
    return { environment, primary };
  }).pipe(
    Effect.provide(makeBackendLayer(runtimeBrand, env, overrides)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  );

describe("BK desktop state integration", () => {
  it.effect("keeps packaged staging state and backend bootstrap in its app-data root", () =>
    Effect.gen(function* () {
      const { environment } = yield* resolvePrimary(BK_RUNTIME_BRANDS.staging);

      assert.equal(
        environment.baseDir,
        "/Users/alice/Library/Application Support/bkt3code-staging",
      );
      assert.equal(environment.userDataDirName, "bkt3code-staging");
    }),
  );

  it.effect("preserves production, explicit-home, and development state overrides", () =>
    Effect.gen(function* () {
      const production = yield* resolvePrimary(BK_RUNTIME_BRANDS.production);
      assert.equal(production.environment.baseDir, "/Users/alice/.t3");

      const explicit = yield* resolvePrimary(BK_RUNTIME_BRANDS.staging, {
        T3CODE_HOME: "/Volumes/agent-state",
      });
      assert.equal(explicit.environment.baseDir, "/Volumes/agent-state");

      const development = yield* resolvePrimary(
        BK_RUNTIME_BRANDS.staging,
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
        { isPackaged: false },
      );
      assert.isTrue(development.environment.isDevelopment);
      assert.equal(development.environment.baseDir, "/Users/alice/.t3");
      assert.deepEqual(
        development.environment.devServerUrl,
        Option.some(new URL("http://localhost:5173/")),
      );
    }),
  );
});
