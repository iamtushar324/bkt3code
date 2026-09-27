import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect } from "vite-plus/test";

import {
  resolveDesktopBuildIconAssets,
  resolveDesktopProductName,
  resolveDesktopStagePackageName,
  resolveGitHubPublishConfig,
} from "./build-desktop-artifact.ts";
import {
  BK_BRAND_ASSET_PATHS,
  BK_DESKTOP_BRANDS,
  DESKTOP_BRAND_ENV_VAR,
} from "./lib/bk-desktop-brand.ts";
import { BK_MANAGED_CHANNEL_ENV_VAR } from "./lib/bk-managed-environment.ts";
import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

// The brand is read from the build environment rather than passed in, so the
// upstream signatures of these functions stay byte-identical and the next
// upstream merge has nothing to reconcile. Tests therefore drive process.env.
const originalBrand = process.env[DESKTOP_BRAND_ENV_VAR];
const originalChannel = process.env[BK_MANAGED_CHANNEL_ENV_VAR];

// Set once, before any Config read. Effect's default ConfigProvider snapshots
// process.env on first use, so a per-test assignment would be silently ignored
// by every test after the first.
process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY = "beknown-work/bkt3code";

function withBkBrand(variant?: "staging" | "production"): void {
  process.env[DESKTOP_BRAND_ENV_VAR] = "bk";
  if (variant) process.env[BK_MANAGED_CHANNEL_ENV_VAR] = variant;
}

function restore(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

afterEach(() => {
  restore(DESKTOP_BRAND_ENV_VAR, originalBrand);
  restore(BK_MANAGED_CHANNEL_ENV_VAR, originalChannel);
});

describe("desktop brand overrides in build-desktop-artifact", () => {
  it("leaves upstream product names untouched", () => {
    expect(resolveDesktopProductName("0.0.17")).toBe("T3 Code (Alpha)");
    expect(resolveDesktopProductName("0.0.17-nightly.20260413.42")).toBe("T3 Code (Nightly)");
  });

  it("names fork builds after the fork, not the nightly channel", () => {
    withBkBrand();
    // Every fork build is nightly-versioned so it reaches the nightly updater
    // channel, so the brand has to win over the nightly label.
    expect(resolveDesktopProductName("0.0.17-production-nightly.20260413.42")).toBe("BK T3 Code");
    expect(resolveDesktopProductName("0.0.17")).toBe("BK T3 Code");
  });

  it("names the staging app distinctly, so it installs beside production", () => {
    // "Stage BK T3 Code" is the name already installed on the team's Macs.
    // productName derives the .app bundle name and Electron's default data
    // directory, so renaming it later strands a duplicate app and its state.
    withBkBrand("staging");
    expect(resolveDesktopProductName("0.0.17-staging-nightly.20260413.42")).toBe(
      "Stage BK T3 Code",
    );
  });

  it("leaves upstream icon selection untouched", () => {
    expect(resolveDesktopBuildIconAssets("0.0.17")).toEqual({
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });
    expect(resolveDesktopBuildIconAssets("0.0.17-nightly.20260413.42")).toEqual({
      macIconPng: BRAND_ASSET_PATHS.nightlyMacIconPng,
      linuxIconPng: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
    });
  });

  it("uses the fork icon set for fork builds, overriding the nightly icons", () => {
    withBkBrand();
    expect(resolveDesktopBuildIconAssets("0.0.17-production-nightly.20260413.42")).toEqual({
      macIconPng: BK_BRAND_ASSET_PATHS.macIconPng,
      linuxIconPng: BK_BRAND_ASSET_PATHS.universalIconPng,
      windowsIconIco: BK_BRAND_ASSET_PATHS.windowsIconIco,
    });
  });
});

describe("updater cache isolation", () => {
  it("gives each app its own global updater cache", () => {
    // electron-builder derives updaterCacheDirName from the staged package name,
    // and electron-updater then downloads into ~/Library/Caches/<name>-updater.
    // That path is OUTSIDE userData, so isolating the bundle id and the
    // user-data directory is not enough — verified on a Mac, where all three
    // apps shared ~/Library/Caches/t3code-updater and could clobber each
    // other's part-downloaded update.
    expect(resolveDesktopStagePackageName()).toBe("t3code");

    withBkBrand("staging");
    expect(resolveDesktopStagePackageName()).toBe("bkt3code-staging");

    withBkBrand("production");
    expect(resolveDesktopStagePackageName()).toBe("bkt3code");
  });

  it("keeps the cache name tied to the user-data directory", () => {
    // Derived from userDataDirName rather than duplicated, so the two isolation
    // axes cannot drift apart in a later edit.
    for (const variant of ["staging", "production"] as const) {
      withBkBrand(variant);
      expect(resolveDesktopStagePackageName()).toBe(BK_DESKTOP_BRANDS[variant].userDataDirName);
    }
  });
});

describe("updater channel in the publish config", () => {
  const publishConfig = (version: string) =>
    resolveGitHubPublishConfig(/-nightly\.\d{8}\.\d+$/.test(version) ? "nightly" : "latest");

  it.effect("leaves upstream on the plain nightly channel", () =>
    Effect.gen(function* () {
      expect(yield* publishConfig("0.0.17-nightly.20260413.42")).toMatchObject({
        releaseType: "prerelease",
        channel: "nightly",
      });
    }),
  );

  it.effect("gives each fork app its own channel, which separates their updates", () =>
    Effect.gen(function* () {
      // Both apps publish into one repository. electron-updater picks a release
      // by matching semver.prerelease(tag)[0] against the running app's channel,
      // so these strings are the entire isolation mechanism — and they must
      // equal the version's first prerelease identifier.
      withBkBrand("staging");
      expect(yield* publishConfig("0.0.17-staging-nightly.20260413.42")).toMatchObject({
        owner: "beknown-work",
        repo: "bkt3code",
        releaseType: "prerelease",
        channel: "staging-nightly",
      });

      withBkBrand("production");
      expect(yield* publishConfig("0.0.17-production-nightly.20260413.42")).toMatchObject({
        releaseType: "prerelease",
        channel: "production-nightly",
      });
    }),
  );

  it.effect("keeps the stable channel free of a fork channel name", () =>
    Effect.gen(function* () {
      // A non-nightly version is a real release; it must not carry a channel key
      // at all, or electron-builder writes a manifest nothing reads.
      withBkBrand("staging");
      expect(yield* publishConfig("0.0.17")).toMatchObject({ releaseType: "release" });
      expect(yield* publishConfig("0.0.17")).not.toHaveProperty("channel");
    }),
  );
});
