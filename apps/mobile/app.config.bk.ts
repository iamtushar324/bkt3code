// T3-CUSTOM(expbkt3): Fork build identity for the Beknown mobile app.
//
// Upstream's `app.config.ts` is branded end to end for the T3 Tools Expo
// project: `owner: "pingdotgg"`, an EAS project id, upstream's Apple team, the
// `com.t3tools.t3code` bundle identifiers and an OTA update URL pointing at
// upstream's Expo channel. None of that is usable here, and none of it should
// be edited in place — every line the fork changes inside an upstream file is a
// line the next upstream merge has to reconcile.
//
// So the fork keeps its identity out here and `app.config.ts` grows a single
// two-line seam that hands its finished config over when `T3CODE_BK_MOBILE=1`.
//
// BK mobile builds are sideloaded, never store-distributed:
//   - Android ships a release APK signed with the fork keystore.
//   - iOS ships an UNSIGNED .ipa that SideStore re-signs with a free Apple ID.
//
// The constants and guards live in scripts/lib/bk-mobile.ts so the build script
// can share them; only the ExpoConfig rewrite is here, because that is where
// the type is available.
//
// See docs/operations/bk-mobile-build.md.
import type { ExpoConfig } from "expo/config";

import {
  assertBkBuildEnvironment,
  BK_MOBILE_APP_NAME,
  BK_MOBILE_BUNDLE_IDENTIFIER,
  BK_MOBILE_DEFAULT_SERVER,
  BK_MOBILE_ICON_PATH,
  BK_MOBILE_SCHEME,
  bkMarketingVersion,
  parseBkAndroidVersionCode,
  parseBkIosBuildNumber,
  type BkRepoEnv,
} from "../../scripts/lib/bk-mobile.ts";

export { isBkMobileBuild } from "../../scripts/lib/bk-mobile.ts";

/**
 * Rewrites a finished upstream Expo config into the fork's identity.
 *
 * Returns a copy; the input is never mutated, so `app.config.ts` stays a pure
 * description of upstream's app.
 */
export function applyBkMobileConfig(config: ExpoConfig, repoEnv: BkRepoEnv): ExpoConfig {
  assertBkBuildEnvironment(repoEnv);

  const gitSha = repoEnv.BK_GIT_SHA?.trim() || null;
  const androidVersionCode = parseBkAndroidVersionCode(repoEnv.BK_ANDROID_VERSION_CODE);
  const iosBuildNumber = parseBkIosBuildNumber(repoEnv.BK_IOS_BUILD_NUMBER);

  const {
    owner: _owner,
    ios: upstreamIos,
    android: upstreamAndroid,
    extra: upstreamExtra,
    ...rest
  } = config;

  const {
    appleTeamId: _appleTeamId,
    associatedDomains: _associatedDomains,
    icon: _iosIcon,
    ...ios
  } = upstreamIos ?? {};
  const { eas: _eas, ...extra } = upstreamExtra ?? {};

  return {
    ...rest,
    name: BK_MOBILE_APP_NAME,
    // `1.0.4.<run>`: upstream's version stays untouched, every build is newer
    // than the last for SideStore. Either platform's run number will do — the
    // workflow hands each job the same one.
    ...(config.version === undefined
      ? {}
      : { version: bkMarketingVersion(config.version, iosBuildNumber ?? androidVersionCode) }),
    scheme: BK_MOBILE_SCHEME,
    icon: BK_MOBILE_ICON_PATH,
    // No EAS project, so no OTA channel to check. Leaving this enabled would
    // point release binaries at upstream's `u.expo.dev` project.
    updates: { enabled: false },
    ios: {
      ...ios,
      ...(iosBuildNumber === null ? {} : { buildNumber: iosBuildNumber }),
      // `bundleIdentifier` is already the BK id: app.config.ts resolves it from
      // T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID, which assertBkBuildEnvironment
      // pins. Rewriting it here would desynchronise it from the extension
      // bundle ids upstream derives from the same value.
      //
      // `appleTeamId` and `associatedDomains` are dropped above: the team is
      // upstream's, and Associated Domains is another entitlement a free Apple
      // ID cannot sign. BK mobile has no Clerk sign-in, so nothing needs the
      // applinks/webcredentials association.
    },
    android: {
      ...upstreamAndroid,
      package: BK_MOBILE_BUNDLE_IDENTIFIER,
      ...(androidVersionCode === null ? {} : { versionCode: androidVersionCode }),
      adaptiveIcon: {
        ...upstreamAndroid?.adaptiveIcon,
        backgroundColor: "#000000",
        foregroundImage: BK_MOBILE_ICON_PATH,
      },
    },
    web: { ...config.web, favicon: BK_MOBILE_ICON_PATH },
    plugins: [
      ...withBkSplashIcon(config.plugins ?? []),
      "./plugins/withBkAndroidReleaseSigning.cjs",
    ],
    extra: {
      ...extra,
      bk: {
        gitSha,
        server: BK_MOBILE_DEFAULT_SERVER,
      },
    },
  };
}

/**
 * Repoints the splash screen at the BK mark. The image path lives inside the
 * `expo-splash-screen` plugin tuple rather than on the config root, so it has
 * to be rewritten in place.
 */
function withBkSplashIcon(
  plugins: NonNullable<ExpoConfig["plugins"]>,
): NonNullable<ExpoConfig["plugins"]> {
  return plugins.map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== "expo-splash-screen") return plugin;
    const options = (plugin[1] ?? {}) as Record<string, unknown>;
    const dark = (options.dark ?? {}) as Record<string, unknown>;
    return [
      "expo-splash-screen",
      { ...options, image: BK_MOBILE_ICON_PATH, dark: { ...dark, image: BK_MOBILE_ICON_PATH } },
    ];
  });
}
