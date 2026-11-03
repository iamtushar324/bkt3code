// Preview builds share nightly branding but ship without an update feed.
// T3-CUSTOM(expbkt3): fork builds carry their brand channel as the first
// prerelease identifier (0.0.32-stage-nightly.20260810.1), and untagged
// integrated upstream revisions append `.upstream.g<sha>`; both stay nightly.
const PRERELEASE_VERSION_PATTERN =
  /^[^-+]+-(?:(?:stage-|production-)?nightly|preview)\.\d{8}\.\d+(?:\.upstream\.g[0-9a-f]+)?$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}
