import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NetService from "@t3tools/shared/Net";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { BK_RUNTIME_BRANDS } from "./BkBrand.ts";
import {
  BK_BUNDLED_BACKEND_PORT_RANGES,
  resolveBkBundledBackendPort,
} from "./BkBundledBackendRuntime.ts";
import { resolveBkDesktopBaseDir } from "./BkDesktopState.ts";

const environmentInput = {
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

const makeEnvironment = (env: Record<string, string | undefined> = {}) =>
  DesktopEnvironment.DesktopEnvironment.pipe(
    Effect.provide(
      DesktopEnvironment.layer(environmentInput).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
        ),
      ),
    ),
  );

const netLayer = (canListenOnHost: (port: number, host: string) => boolean) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: (port, host) => Effect.succeed(canListenOnHost(port, host)),
    isPortAvailableOnLoopback: () => Effect.die("unexpected loopback probe"),
    hasListenerOnHost: () => Effect.die("unexpected listener probe"),
    reserveLoopbackPort: () => Effect.die("unexpected port reservation"),
    findAvailablePort: () => Effect.die("unexpected generic port search"),
  } satisfies NetService.NetServiceShape);

describe("BK desktop channel isolation", () => {
  it.effect("keeps production on its existing root while staging gets an app-data root", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.equal(
        resolveBkDesktopBaseDir({
          appDataDirectory: environment.appDataDirectory,
          defaultBaseDir: environment.baseDir,
          isDevelopment: false,
          joinPath: environment.path.join,
          runtimeBrand: BK_RUNTIME_BRANDS.production,
          configuredT3Home: Option.none(),
        }),
        "/Users/alice/.t3",
      );
      assert.equal(
        resolveBkDesktopBaseDir({
          appDataDirectory: environment.appDataDirectory,
          defaultBaseDir: environment.baseDir,
          isDevelopment: false,
          joinPath: environment.path.join,
          runtimeBrand: BK_RUNTIME_BRANDS.staging,
          configuredT3Home: Option.none(),
        }),
        "/Users/alice/Library/Application Support/bkt3code-staging",
      );
      assert.equal(
        resolveBkDesktopBaseDir({
          appDataDirectory: environment.appDataDirectory,
          defaultBaseDir: environment.baseDir,
          isDevelopment: false,
          joinPath: environment.path.join,
          runtimeBrand: undefined,
          configuredT3Home: Option.none(),
        }),
        "/Users/alice/.t3",
      );
    }),
  );

  it.effect("keeps explicit homes and development behavior unchanged", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ T3CODE_HOME: "/Volumes/agent-state" });

      assert.equal(
        resolveBkDesktopBaseDir({
          appDataDirectory: environment.appDataDirectory,
          defaultBaseDir: environment.baseDir,
          isDevelopment: false,
          joinPath: environment.path.join,
          runtimeBrand: BK_RUNTIME_BRANDS.staging,
          configuredT3Home: Option.some("/Volumes/agent-state"),
        }),
        "/Volumes/agent-state",
      );
      assert.equal(
        resolveBkDesktopBaseDir({
          appDataDirectory: environment.appDataDirectory,
          defaultBaseDir: "/Users/alice/.t3",
          isDevelopment: true,
          joinPath: environment.path.join,
          runtimeBrand: BK_RUNTIME_BRANDS.staging,
          configuredT3Home: Option.none(),
        }),
        "/Users/alice/.t3",
      );
    }),
  );

  it.effect("uses distinct channel ranges and preserves an explicit T3CODE_PORT", () =>
    Effect.gen(function* () {
      assert.deepEqual(BK_BUNDLED_BACKEND_PORT_RANGES.production, { start: 3773, end: 3872 });
      assert.deepEqual(BK_BUNDLED_BACKEND_PORT_RANGES.staging, { start: 4773, end: 4872 });

      const port = yield* resolveBkBundledBackendPort({
        channel: "staging",
        configuredPort: Option.some(6123),
      });
      assert.deepEqual(port, { port: 6123, selectedByScan: false });
    }).pipe(Effect.provide(netLayer(() => false))),
  );

  it.effect("falls forward inside the channel range when its default port is occupied", () =>
    Effect.gen(function* () {
      const port = yield* resolveBkBundledBackendPort({
        channel: "production",
        configuredPort: Option.none(),
      });
      assert.deepEqual(port, { port: 3774, selectedByScan: true });
    }).pipe(Effect.provide(netLayer((port) => port !== 3773))),
  );

  it.effect("does not fall into the other channel's range after exhaustion", () =>
    Effect.gen(function* () {
      const error = yield* resolveBkBundledBackendPort({
        channel: "staging",
        configuredPort: Option.none(),
      }).pipe(Effect.flip);

      assert.equal(error.channel, "staging");
      assert.equal(error.startPort, 4773);
      assert.equal(error.maxPort, 4872);
    }).pipe(Effect.provide(netLayer(() => false))),
  );
});
