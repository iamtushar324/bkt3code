import "vite-plus/test/config";
import * as NodeOS from "node:os";

import { defaultInclude, defineConfig } from "vite-plus";
import { Rolldown } from "vite-plus/pack";

// T3-CUSTOM(expbkt3): BEGIN - fork desktop brand selection.
import {
  resolveBkDesktopVariant,
  resolveDesktopBrandId,
} from "../../scripts/lib/bk-desktop-brand.ts";
import { resolveBkManagedEnvironment } from "../../scripts/lib/bk-managed-environment.ts";
// T3-CUSTOM(expbkt3): END
import { isDesktopRuntimeExternalDependency } from "../../scripts/lib/desktop-external-packages.ts";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoEnv = loadRepoEnv();
const domTests = ["src/preview/PickPreload.test.ts"];

// Install only bundle externals; the server bundle already carries its dependency tree.
const isMainProcessExternal = (id: string) =>
  id === "electron" || id.startsWith("electron/") || isDesktopRuntimeExternalDependency(id);
const shouldLaunchElectronAfterPack = process.env.T3CODE_DESKTOP_DEV === "1";
// tsdown runs onSuccess through a shell. dash forks instead of exec'ing the last command, which
// would leave an `sh` between `vp pack` and the supervisor and hide `vp pack` dying from it.
const devElectronCommand =
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Build config has no Effect runtime.
  NodeOS.platform() === "win32"
    ? "node scripts/dev-electron.mjs"
    : "exec node scripts/dev-electron.mjs";
const publicConfigDefine = {
  __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
    repoEnv.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
  ),
  // T3-CUSTOM(expbkt3): BEGIN - bake the desktop brand in. Nothing sets
  // T3CODE_BRAND on a user's machine, so it has to be a build-time constant; see
  // src/branding/BkBrand.ts and scripts/lib/bk-desktop-brand.ts.
  __T3CODE_BUILD_BRAND__: JSON.stringify(resolveDesktopBrandId(process.env)),
  // Which of the two fork apps this is. Baked for the same reason as the brand:
  // T3CODE_BK_MANAGED_CHANNEL does not exist on a user's machine.
  __T3CODE_BUILD_BRAND_VARIANT__: JSON.stringify(resolveBkDesktopVariant(process.env)),
  // Managed BK builds are client-only. Electron needs the same target as the
  // renderer so it can skip the local server and open the packaged client.
  __T3CODE_BK_MANAGED_ENVIRONMENT__: JSON.stringify(
    resolveBkManagedEnvironment(process.env) ?? null,
  ),
  // T3-CUSTOM(expbkt3): END
};

const PAGE_WORLD_MODULE = /[\\/]src[\\/]preview[\\/]PageWorld\.ts$/;

/**
 * The preview preload passes `installPageWorld` to `contextBridge.executeInMainWorld`, which runs
 * the function's source text in the page. Inline the module's imports into the function body so
 * that text is complete on its own.
 */
const pageWorldFunction = (): Rolldown.Plugin => ({
  name: "t3code:preview-page-world",
  async load(id) {
    if (!PAGE_WORLD_MODULE.test(id)) return null;
    const bundle = await Rolldown.rolldown({ input: id, platform: "browser" });
    try {
      const { output } = await bundle.generate({ format: "iife", name: "pageWorld" });
      for (const file of await bundle.watchFiles) this.addWatchFile(file);
      return `export function installPageWorld(host) {\n${output[0].code}\nreturn pageWorld.installPageWorld(host);\n}\n`;
    } finally {
      await bundle.close();
    }
  },
});

export default defineConfig({
  run: {
    tasks: {
      build: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-apple-speech.mjs && node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      // CI bundle jobs skip the Linux browser secret helper; packaging stages one per arch.
      "build:bundle": {
        command: "node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-apple-speech.mjs && node scripts/build-preview-annotation-css.mjs && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["t3#build"],
        cache: false,
      },
      "dev:bundle": {
        command:
          "node scripts/build-browser-secret.mjs && node scripts/build-apple-speech.mjs && node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        dependsOn: ["t3#build"],
        cache: false,
      },
      // A local tsbuildinfo is leftover build state, not a typecheck input.
      typecheck: {
        command: "effect-tsgo tsrs --noEmit",
        cache: { input: [{ auto: true }, "!*.tsbuildinfo"] },
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      outputOptions: { codeSplitting: false },
      entry: ["src/main.ts"],
      clean: true,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: devElectronCommand } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: [
        "src/backend/DesktopBackendRecoveryWorker.ts",
        "src/electron/WindowsForegroundFocusWorker.ts",
        "src/snapShot/GlobalShiftShortcutWorker.ts",
        "src/snapShot/RegionSnapShotWorker.ts",
        "src/snapShot/SnapShotAccessibilityWorker.ts",
      ],
      clean: false,
      deps: {
        alwaysBundle: (id) => !id.startsWith("node:") && !isMainProcessExternal(id),
        neverBundle: isMainProcessExternal,
        onlyBundle: false,
      },
    },
    {
      // boot.cjs requires the other two at runtime, so all three stay separate files.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/boot.ts", "src/compileCache.ts", "src/serverCompileCache.ts"],
      clean: false,
      deps: {
        neverBundle: (id) => id === "./main.cjs" || id === "./compileCache.cjs",
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      define: publicConfigDefine,
      entry: ["src/preload.ts"],
      deps: {
        // Sandboxed preloads cannot resolve imports inside ASAR; bundle Clerk's bridge.
        alwaysBundle: (id) => id === "@clerk/electron" || id.startsWith("@clerk/electron/"),
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      plugins: [pageWorldFunction()],
      deps: {
        alwaysBundle: (id) => id === "@t3tools/shared/keybindingMatching",
      },
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pip-preload.ts"],
    },
    {
      // Sandboxed preloads must be self-contained, without shared runtime chunks.
      format: "cjs",
      outDir: "dist-electron",
      dts: false,
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/mac-permission-preload.ts"],
    },
  ],
  test: {
    // The Windows lane runs workspace suites concurrently; filesystem-heavy
    // desktop integration tests can exceed Vitest's 5 second default there.
    testTimeout: 15_000,
    // `require("electron")` downloads a missing binary, so concurrent workers race to
    // extract it into the same dist/. Install it once before any worker starts.
    globalSetup: ["./scripts/ensure-electron-runtime.mjs"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [...defaultInclude, "../../native/kde-snap-shot/src/*.test.ts"],
          exclude: ["**/node_modules/**", ...domTests],
          setupFiles: [
            "../../packages/shared/src/testing/longTempDir.ts",
            "../../packages/shared/src/testing/providerEnv.ts",
            "../../packages/shared/src/testing/gitEnv.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: domTests,
          // Guest preloads run in the page; these tests drive them against a DOM.
          environment: "jsdom",
          setupFiles: [
            "../../packages/shared/src/testing/providerEnv.ts",
            "../../packages/shared/src/testing/gitEnv.ts",
          ],
        },
      },
    ],
  },
});
