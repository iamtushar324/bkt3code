/**
 * Fork-owned macOS code signing for the Beknown desktop build.
 *
 * Why this exists at all: Squirrel.Mac validates an update bundle against the
 * *installed* app's designated requirement before swapping it in. An unsigned
 * app has no requirement to satisfy, so unsigned builds can download an update
 * and then silently fail to install it — auto-update is only real once the app
 * is signed.
 *
 * Why not upstream's `--signed`: that flag routes macOS builds through
 * `resolveMacPasskeySigningConfiguration`, which hard-requires
 * `T3CODE_APPLE_TEAM_ID` and `T3CODE_MACOS_PROVISIONING_PROFILE`. Apple's
 * certificates are bound to upstream's `com.t3tools.t3code` App ID, so the fork
 * has neither and that path fails before electron-builder starts.
 *
 * What the fork does instead: signs with a self-signed code-signing certificate
 * from the build machine's login keychain. The designated requirement is then
 * `identifier + leaf certificate hash`, which is stable across builds as long as
 * the same certificate signs every one of them — which is exactly what
 * Squirrel.Mac needs. The trade-offs, both accepted:
 *
 * - **Not notarised.** Gatekeeper still quarantines the downloaded DMG, cleared
 *   once per install with the `xattr -dr` step in
 *   `docs/operations/bk-desktop-build.md`.
 * - **The certificate is load-bearing.** Rotating or losing it breaks
 *   auto-update for every already-installed app, and teammates have to reinstall
 *   by hand. Back it up.
 */

/** Common name of the self-signed certificate to sign macOS builds with. */
export const BK_SIGNING_IDENTITY_ENV_VAR = "T3CODE_BK_SIGNING_IDENTITY";

/**
 * The configured signing identity, or `undefined` for an unsigned build.
 *
 * Unset is a supported mode — it is what a quick local build wants — but such a
 * build cannot be published: `publish-bk-desktop-dmg.ts` refuses it, because
 * shipping an unsigned build to the updater channel breaks auto-update for
 * everyone already on it.
 */
export function resolveBkSigningIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const identity = env[BK_SIGNING_IDENTITY_ENV_VAR]?.trim();
  return identity ? identity : undefined;
}
