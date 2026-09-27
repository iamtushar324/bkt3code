/**
 * T3-CUSTOM(expbkt3): Shared identity for the fork's mobile builds.
 *
 * Lives here rather than under apps/mobile because both sides need it and only
 * this direction is allowed: `apps/mobile/app.config.ts` already imports from
 * `scripts/lib`, while a script importing out of the mobile package crosses a
 * TypeScript project boundary.
 *
 * The Expo-config rewrite itself stays in `apps/mobile/app.config.bk.ts`, which
 * is where the `ExpoConfig` type is available.
 *
 * See docs/operations/bk-mobile-build.md.
 */

/** Reverse-DNS identity for the fork app. Must not collide with upstream's. */
export const BK_MOBILE_BUNDLE_IDENTIFIER = "work.beknown.bkt3code.mobile";
export const BK_MOBILE_APP_NAME = "BK T3 Code";
export const BK_MOBILE_SCHEME = "t3code-bk";
/** The fork production server BK builds are expected to pair with. */
export const BK_MOBILE_DEFAULT_SERVER = "bkt3.dev.beknown.live";
/** Relative to apps/mobile, which is where the Expo config is resolved. */
export const BK_MOBILE_ICON_PATH = "../../assets/bk/bk-universal-1024.png";

/** Seven characters: the same abbreviation `git log --oneline` prints. */
const SHORT_SHA_LENGTH = 7;

export type BkMobilePlatform = "android" | "ios";
export type BkRepoEnv = Record<string, string | undefined>;

export function isBkMobileBuild(repoEnv: BkRepoEnv): boolean {
  return repoEnv.T3CODE_BK_MOBILE === "1";
}

/**
 * BK builds must be personal-team signed with the fork bundle id. Both are
 * correctness requirements rather than preferences, so they fail the config
 * rather than the build 40 minutes later.
 *
 * `T3CODE_IOS_PERSONAL_TEAM=1` is required on BOTH platforms: on Android every
 * capability it removes is iOS-only, so it changes nothing there, and requiring
 * it unconditionally means a BK build can never silently inherit upstream's
 * bundle identifier.
 */
export function assertBkBuildEnvironment(repoEnv: BkRepoEnv): void {
  if (repoEnv.T3CODE_IOS_PERSONAL_TEAM !== "1") {
    throw new Error(
      "BK mobile builds require T3CODE_IOS_PERSONAL_TEAM=1 so the iOS archive drops the " +
        "entitlements a free Apple ID cannot sign. Build through scripts/build-bk-mobile.ts.",
    );
  }
  if (repoEnv.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID?.trim() !== BK_MOBILE_BUNDLE_IDENTIFIER) {
    throw new Error(
      `BK mobile builds require T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=${BK_MOBILE_BUNDLE_IDENTIFIER}. ` +
        "Anything else risks colliding with the upstream app on the same device.",
    );
  }
}

export function parseBkAndroidVersionCode(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`BK_ANDROID_VERSION_CODE must be a positive integer (received "${value}").`);
  }
  return parsed;
}

/**
 * SideStore compares the native version and build number when deciding whether
 * an installed IPA has an update. MOBILE_APP_VERSION intentionally changes
 * only for product releases, so every CI-built IPA also needs a monotonically
 * increasing CFBundleVersion.
 */
export function parseBkIosBuildNumber(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`BK_IOS_BUILD_NUMBER must be a positive integer (received "${value}").`);
  }
  return normalized;
}

/** The environment every BK build shares. See assertBkBuildEnvironment. */
export function bkBuildEnv(gitSha: string): Record<string, string> {
  return {
    APP_VARIANT: "production",
    T3CODE_BK_MOBILE: "1",
    T3CODE_IOS_PERSONAL_TEAM: "1",
    T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: BK_MOBILE_BUNDLE_IDENTIFIER,
    // Fingerprint runtime versions only matter for OTA updates, which BK
    // builds do not use (app.config.bk.ts disables expo-updates).
    MOBILE_VERSION_POLICY: "appVersion",
    EXPO_NO_GIT_STATUS: "1",
    BK_GIT_SHA: gitSha,
  };
}

/**
 * `1.0.4+bk.a1b2c3d` — a semver build-metadata suffix, so it stays a valid
 * version for anything that parses it. This is what the server records as
 * `client_version`, and the only way to tell a stale sideloaded binary from a
 * current one.
 */
/**
 * The native marketing version (`CFBundleShortVersionString` / `versionName`)
 * of one BK build: upstream's MOBILE_APP_VERSION plus the workflow run number
 * as a fourth component, `1.0.4.12`.
 *
 * MOBILE_APP_VERSION is never bumped by the fork — it tracks upstream, so an
 * upstream merge never conflicts on it. But SideStore decides "update
 * available" on the marketing version, and not every SideStore release falls
 * back to the build number when two builds share one. A fourth component that
 * grows with every run makes each build unambiguously newer for all of them.
 * Release tags, artifact names and the `client_version` the app reports keep
 * the three-part base.
 */
export function bkMarketingVersion(
  baseVersion: string,
  buildNumber: string | number | null,
): string {
  return buildNumber === null ? baseVersion : `${baseVersion}.${buildNumber}`;
}

export function bkAppVersionString(baseVersion: string, gitSha: string): string {
  return `${baseVersion}+bk.${gitSha.slice(0, SHORT_SHA_LENGTH)}`;
}

export function bkArtifactFileName(
  platform: BkMobilePlatform,
  baseVersion: string,
  gitSha: string,
): string {
  const extension = platform === "android" ? "apk" : "ipa";
  return `bk-t3code-${baseVersion}-${gitSha.slice(0, SHORT_SHA_LENGTH)}.${extension}`;
}

export function bkReleaseTag(baseVersion: string, gitSha: string): string {
  return `bk-mobile-v${baseVersion}-${gitSha.slice(0, SHORT_SHA_LENGTH)}`;
}

/**
 * Reads MOBILE_APP_VERSION out of `apps/mobile/app-version.ts`.
 *
 * Parsed rather than imported: that file belongs to the mobile TypeScript
 * project, and importing across the boundary is what this module exists to
 * avoid. It is a one-line constant, so a regex is honest here.
 */
export function parseMobileAppVersion(contents: string): string {
  const match = /MOBILE_APP_VERSION\s*=\s*"(\d+\.\d+\.\d+[^"]*)"/.exec(contents);
  if (match === null) {
    throw new Error("Could not read MOBILE_APP_VERSION from apps/mobile/app-version.ts.");
  }
  return match[1]!;
}
