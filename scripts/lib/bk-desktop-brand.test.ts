import { describe, expect, it } from "vite-plus/test";

import {
  BK_DESKTOP_BRAND,
  BK_DESKTOP_BRANDS,
  DESKTOP_BRAND_ENV_VAR,
  resolveBkDesktopBrand,
  resolveBkDesktopVariant,
  resolveDesktopBrandId,
} from "./bk-desktop-brand.ts";
import { BK_MANAGED_CHANNEL_ENV_VAR } from "./bk-managed-environment.ts";

// Note: assertions about how build-desktop-artifact.ts consumes this brand live in
// scripts/bk-desktop-brand-overrides.test.ts, not here. Everything under
// scripts/lib/ is part of the apps/desktop TypeScript project (its vite.config
// imports this module), and importing a scripts/ root file from here puts that
// file outside the desktop project's file list, which fails its typecheck.

describe("bk-desktop-brand", () => {
  it("defaults to the upstream brand when the flag is absent", () => {
    expect(resolveDesktopBrandId({})).toBe("upstream");
    expect(resolveBkDesktopBrand({})).toBeUndefined();
  });

  it("selects the fork brand from the build flag, case- and space-insensitively", () => {
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: "bk" })).toBe("bk");
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: " BK " })).toBe("bk");
    expect(resolveBkDesktopBrand({ [DESKTOP_BRAND_ENV_VAR]: "bk" })).toBe(BK_DESKTOP_BRAND);
  });

  it("ignores unrelated brand values rather than guessing", () => {
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: "beknown" })).toBe("upstream");
    expect(resolveDesktopBrandId({ [DESKTOP_BRAND_ENV_VAR]: "" })).toBe("upstream");
  });

  it("keeps the fork bundle id distinct from upstream so both can be installed", () => {
    expect(BK_DESKTOP_BRAND.appId).toBe("work.beknown.bkt3code");
    expect(BK_DESKTOP_BRAND.appId).not.toBe("com.t3tools.t3code");
  });

  it("gives the fork its own user-data directory", () => {
    // A shared directory would mean the fork app reads an upstream install's
    // settings, saved environments and sessions.
    expect(BK_DESKTOP_BRAND.userDataDirName).toBe("bkt3code");
    expect(BK_DESKTOP_BRAND.userDataDirName).not.toBe("t3code");
  });

  it("stamps artifacts with a fork-specific name", () => {
    expect(BK_DESKTOP_BRAND.artifactName).toBe("BK-T3-Code-${version}-${arch}.${ext}");
  });
});

describe("bk-desktop-brand variants", () => {
  it("defaults to production, so an unqualified fork build keeps its identity", () => {
    expect(resolveBkDesktopVariant({})).toBe("production");
    expect(resolveBkDesktopVariant({ [BK_MANAGED_CHANNEL_ENV_VAR]: "" })).toBe("production");
    expect(BK_DESKTOP_BRAND).toBe(BK_DESKTOP_BRANDS.production);
  });

  it("selects the variant from the managed channel", () => {
    expect(resolveBkDesktopVariant({ [BK_MANAGED_CHANNEL_ENV_VAR]: "staging" })).toBe("staging");
    expect(resolveBkDesktopVariant({ [BK_MANAGED_CHANNEL_ENV_VAR]: " PRODUCTION " })).toBe(
      "production",
    );
    expect(
      resolveBkDesktopBrand({
        [DESKTOP_BRAND_ENV_VAR]: "bk",
        [BK_MANAGED_CHANNEL_ENV_VAR]: "staging",
      }),
    ).toBe(BK_DESKTOP_BRANDS.staging);
  });

  it("falls back rather than throwing on an unknown channel", () => {
    // resolveBkManagedEnvironment owns that error and runs on the same variable,
    // so raising a second one here would just obscure it.
    expect(resolveBkDesktopVariant({ [BK_MANAGED_CHANNEL_ENV_VAR]: "nonsense" })).toBe(
      "production",
    );
  });

  it("keeps the two apps separable by everything macOS identifies an app by", () => {
    const { staging, production } = BK_DESKTOP_BRANDS;
    // If any of these collide, installing one app overwrites or hijacks the
    // other's identity, settings or sessions.
    expect(staging.appId).not.toBe(production.appId);
    expect(staging.productName).not.toBe(production.productName);
    expect(staging.userDataDirName).not.toBe(production.userDataDirName);
    expect(staging.appUserModelId).not.toBe(production.appUserModelId);
    expect(staging.artifactName).not.toBe(production.artifactName);
    expect(staging.linuxExecutableName).not.toBe(production.linuxExecutableName);
    expect(staging.linuxDesktopEntryName).not.toBe(production.linuxDesktopEntryName);
    expect(staging.linuxWmClass).not.toBe(production.linuxWmClass);
  });

  it("gives each app its own updater channel", () => {
    // This is what stops a staging release being offered to production users.
    expect(BK_DESKTOP_BRANDS.staging.updateChannel).toBe("staging-nightly");
    expect(BK_DESKTOP_BRANDS.production.updateChannel).toBe("production-nightly");
  });

  it("does not disturb the production identity the fork already ships", () => {
    expect(BK_DESKTOP_BRANDS.production.appId).toBe("work.beknown.bkt3code");
    expect(BK_DESKTOP_BRANDS.production.productName).toBe("BK T3 Code");
    expect(BK_DESKTOP_BRANDS.production.userDataDirName).toBe("bkt3code");
  });
});
