import type { DesktopUpdateChannel } from "@t3tools/contracts";

// T3-CUSTOM(expbkt3): BEGIN - fork builds carry their brand channel as the
// first prerelease identifier (0.0.32-staging-nightly.20260810.1), and untagged
// integrated upstream revisions append `.upstream.g<sha>`; both stay nightly.
const NIGHTLY_VERSION_PATTERN =
  /^[^-+]+-(?:staging-|production-)?nightly\.\d{8}\.\d+(?:\.upstream\.g[0-9a-f]+)?$/;
// T3-CUSTOM(expbkt3): END
// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They share nightly's branding but
// are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
// T3-CUSTOM(expbkt3): the fork's brand-channel prefix and upstream-revision suffix.
const PRERELEASE_VERSION_PATTERN =
  /^[^-+]+-(?:(?:staging-|production-)?nightly|preview)\.\d{8}\.\d+(?:\.upstream\.g[0-9a-f]+)?$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}
