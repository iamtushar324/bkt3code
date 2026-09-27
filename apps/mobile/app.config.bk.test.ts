import { describe, expect, it } from "vite-plus/test";

import { applyBkMobileConfig, isBkMobileBuild } from "./app.config.bk.ts";

const BK_ENV = {
  T3CODE_BK_MOBILE: "1",
  T3CODE_IOS_PERSONAL_TEAM: "1",
  T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "work.beknown.bkt3code.mobile",
};

// A trimmed stand-in for the finished upstream config: only the fields the
// fork override rewrites, so a change upstream makes elsewhere cannot break
// these assertions.
const upstreamConfig = {
  name: "T3 Code",
  slug: "t3-code",
  scheme: "t3code",
  icon: "../../assets/prod/black-ios-1024.png",
  updates: {
    enabled: true,
    url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",
  },
  ios: {
    icon: "../../assets/prod/app-icon.icon",
    bundleIdentifier: "work.beknown.bkt3code.mobile",
    appleTeamId: "ARK85ZXQ4Z",
    associatedDomains: ["applinks:clerk.t3.codes"],
    supportsTablet: true,
  },
  android: {
    package: "com.t3tools.t3code",
    adaptiveIcon: { backgroundColor: "#000000", monochromeImage: "./assets/android-icon-mark.png" },
  },
  plugins: [
    "expo-asset",
    ["expo-splash-screen", { image: "../../assets/prod/black-ios-1024.png", dark: { image: "x" } }],
  ],
  extra: {
    appVariant: "production",
    eas: { projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454" },
  },
  owner: "pingdotgg",
} as any;

describe("isBkMobileBuild", () => {
  it("only activates on the explicit opt-in", () => {
    expect(isBkMobileBuild({})).toBe(false);
    expect(isBkMobileBuild({ T3CODE_BK_MOBILE: "0" })).toBe(false);
    expect(isBkMobileBuild({ T3CODE_BK_MOBILE: "1" })).toBe(true);
  });
});

describe("applyBkMobileConfig", () => {
  it("rewrites identity and strips upstream's distribution channel", () => {
    const config = applyBkMobileConfig(upstreamConfig, BK_ENV);

    expect(config.name).toBe("BK T3 Code");
    expect(config.scheme).toBe("t3code-bk");
    expect(config.android?.package).toBe("work.beknown.bkt3code.mobile");
    // The upstream app must stay installable alongside the fork one.
    expect(config.android?.package).not.toBe(upstreamConfig.android.package);
    expect(config.updates).toEqual({ enabled: false });
    expect(config.owner).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.extra?.appVariant).toBe("production");
  });

  it("drops the entitlements a free Apple ID cannot sign", () => {
    const config = applyBkMobileConfig(upstreamConfig, BK_ENV);

    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.ios?.associatedDomains).toBeUndefined();
    // Left alone on purpose: app.config.ts derives the widget and share
    // extension bundle ids from it, so rewriting it here would desync them.
    expect(config.ios?.bundleIdentifier).toBe("work.beknown.bkt3code.mobile");
  });

  it("records the build SHA for the server-side client_version", () => {
    const config = applyBkMobileConfig(upstreamConfig, { ...BK_ENV, BK_GIT_SHA: "a1b2c3d4" });
    expect(config.extra?.bk).toEqual({ gitSha: "a1b2c3d4", server: "bkt3.dev.beknown.live" });

    const withoutSha = applyBkMobileConfig(upstreamConfig, BK_ENV);
    expect(withoutSha.extra?.bk).toEqual({ gitSha: null, server: "bkt3.dev.beknown.live" });
  });

  it("appends the signing plugin and repoints the splash icon", () => {
    const config = applyBkMobileConfig(upstreamConfig, BK_ENV);

    expect(config.plugins).toContain("./plugins/withBkAndroidReleaseSigning.cjs");
    const splash = config.plugins?.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
    ) as [string, { image: string; dark: { image: string } }];
    expect(splash[1].image).toBe("../../assets/bk/bk-universal-1024.png");
    expect(splash[1].dark.image).toBe("../../assets/bk/bk-universal-1024.png");
  });

  it("does not mutate the upstream config", () => {
    applyBkMobileConfig(upstreamConfig, BK_ENV);
    expect(upstreamConfig.name).toBe("T3 Code");
    expect(upstreamConfig.owner).toBe("pingdotgg");
  });

  it("refuses a build that could inherit upstream's iOS identity", () => {
    expect(() => applyBkMobileConfig(upstreamConfig, { T3CODE_BK_MOBILE: "1" })).toThrow(
      /T3CODE_IOS_PERSONAL_TEAM=1/,
    );
    expect(() =>
      applyBkMobileConfig(upstreamConfig, {
        ...BK_ENV,
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.t3tools.t3code",
      }),
    ).toThrow(/T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID/);
  });

  it("accepts an explicit Android version code and rejects nonsense", () => {
    const config = applyBkMobileConfig(upstreamConfig, {
      ...BK_ENV,
      BK_ANDROID_VERSION_CODE: "42",
    });
    expect(config.android?.versionCode).toBe(42);

    expect(() =>
      applyBkMobileConfig(upstreamConfig, { ...BK_ENV, BK_ANDROID_VERSION_CODE: "nope" }),
    ).toThrow(/positive integer/);
  });

  it("uses a unique iOS build number for SideStore updates", () => {
    const config = applyBkMobileConfig(upstreamConfig, {
      ...BK_ENV,
      BK_IOS_BUILD_NUMBER: "42",
    });
    expect(config.ios?.buildNumber).toBe("42");
    // The run number is also the fourth component of the marketing version, so
    // SideStore sees each build as newer without MOBILE_APP_VERSION moving.
    const versioned = { ...upstreamConfig, version: "1.0.4" };
    expect(applyBkMobileConfig(versioned, { ...BK_ENV, BK_IOS_BUILD_NUMBER: "42" }).version).toBe(
      "1.0.4.42",
    );
    expect(applyBkMobileConfig(versioned, BK_ENV).version).toBe("1.0.4");

    expect(() =>
      applyBkMobileConfig(upstreamConfig, { ...BK_ENV, BK_IOS_BUILD_NUMBER: "4.2" }),
    ).toThrow(/positive integer/);
    expect(() =>
      applyBkMobileConfig(upstreamConfig, { ...BK_ENV, BK_IOS_BUILD_NUMBER: "0" }),
    ).toThrow(/positive integer/);
  });
});
