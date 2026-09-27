// T3-CUSTOM(expbkt3): Resolve the fork build's exact source revision.
//
// There is no protocol version handshake between a T3 client and a T3 server.
// A mobile binary older than the server it pairs with hard-fails its
// orchestration subscription — an Effect defect, not a typed failure, so it
// does not retry and the UI simply stops updating while still reading
// "connected". The fix is always "re-sideload from the server's SHA", and the
// only way to know that is needed is for the client to say which SHA it is.
//
// scripts/build-bk-mobile.ts stamps BK_GIT_SHA into `extra.bk.gitSha`
// (app.config.bk.ts); the server records the resulting version string as
// `client_version` at token exchange.
//
// Kept free of react-native and expo-constants imports so it stays unit
// testable — the Expo manifest read lives in bkBuildManifest.ts.

/** Seven characters: the same abbreviation `git log --oneline` prints. */
const SHORT_SHA_LENGTH = 7;

/** Narrows whatever the Expo manifest actually holds down to a usable SHA. */
export function readBkGitSha(extra: unknown): string | null {
  if (typeof extra !== "object" || extra === null) return null;
  const bk = (extra as { bk?: unknown }).bk;
  if (typeof bk !== "object" || bk === null) return null;
  const gitSha = (bk as { gitSha?: unknown }).gitSha;
  return typeof gitSha === "string" && gitSha.trim() !== "" ? gitSha.trim() : null;
}

/**
 * `1.0.4+bk.a1b2c3d` for a fork build, plain `1.0.4` otherwise — a semver
 * build-metadata suffix, so it stays a valid version for anything that parses
 * it and reads naturally in a server log.
 */
export function bkAppVersion(baseVersion: string, gitSha: string | null): string {
  if (gitSha === null) return baseVersion;
  return `${baseVersion}+bk.${gitSha.slice(0, SHORT_SHA_LENGTH)}`;
}
