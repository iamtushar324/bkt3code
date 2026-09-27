/**
 * Fork-owned desktop brand identity.
 *
 * The Beknown fork ships its own macOS build so the team can run fork work as a
 * real app. That build must install *alongside* an upstream T3 Code rather than
 * over it, which means a distinct bundle id, product name, icon and user-data
 * directory. Everything specific to that identity lives here so the seams inside
 * upstream-owned files stay one-liners that delegate to this module — see
 * "Building features that survive upstream merges" in AGENTS.md.
 *
 * The brand is selected at *build* time via `T3CODE_BRAND=bk` and baked into the
 * packaged app (see `apps/desktop/src/branding/BkBrand.ts`). It is never read
 * from the environment on a user's machine, because nothing sets it there.
 *
 * There are two fork apps, one per managed environment: `expbkmain` builds ship
 * "BK T3 Code (Staging)" and `bkmain` builds ship "BK T3 Code". They differ in
 * every field that decides whether macOS treats them as the same app — bundle
 * id, product name, user-data directory — and in `updateChannel`, which is what
 * keeps their auto-updates from crossing over.
 *
 * Deliberately NOT changed by this brand:
 *
 * - The `t3code://` URL scheme. `@clerk/electron`'s OAuth transport supplies the
 *   `t3code://app/` redirect (see apps/web/src/components/clerk/authRedirect.ts),
 *   so renaming it risks breaking sign-in in the packaged app. The cost is that
 *   macOS picks one app when several of upstream, staging and production are
 *   installed and a `t3code://` link is opened. Sign-in still completes; it may
 *   just complete in the sibling app.
 * - `DesktopAppStageLabel` in packages/contracts. It stays "Nightly" for the
 *   nightly-versioned builds this brand produces; only the displayed name
 *   changes, so the upstream contract union is untouched.
 */

import {
  BK_MANAGED_CHANNEL_ENV_VAR,
  isBkManagedChannel,
  type BkManagedChannel,
} from "./bk-managed-environment.ts";

/** Environment variable that selects the desktop brand at build time. */
export const DESKTOP_BRAND_ENV_VAR = "T3CODE_BRAND";

/** Value of {@link DESKTOP_BRAND_ENV_VAR} that selects the Beknown brand. */
export const BK_DESKTOP_BRAND_ID = "bk";

export type DesktopBrandId = "upstream" | "bk";

/** Repository whose GitHub releases the fork's desktop updater reads. */
export const BK_DESKTOP_UPDATE_REPOSITORY = "beknown-work/bkt3code";

/**
 * The fork ships one app per managed environment, so `expbkmain` and `bkmain`
 * builds install and update independently instead of overwriting each other.
 * The variant is the managed channel: there is no third axis to configure.
 */
export type BkDesktopVariant = BkManagedChannel;

/**
 * Variant used when {@link BK_MANAGED_CHANNEL_ENV_VAR} is unset.
 *
 * `production`, so a plain `T3CODE_BRAND=bk` build keeps the identity the fork
 * has always produced — an unqualified local build is still "BK T3 Code".
 */
export const BK_DESKTOP_DEFAULT_VARIANT: BkDesktopVariant = "production";

export interface DesktopBrand {
  readonly id: DesktopBrandId;
  /** Managed environment this build targets; also selects the updater channel. */
  readonly variant: BkDesktopVariant;
  /** macOS/Windows bundle identifier and electron-builder `appId`. */
  readonly appId: string;
  /** electron-builder `productName`; also names the macOS `.app` and its data dir. */
  readonly productName: string;
  /** Name shown in-app (window title, About panel). */
  readonly displayName: string;
  /** electron-builder `artifactName` template. Braces are builder placeholders. */
  readonly artifactName: string;
  /** Directory under the OS app-data root that Electron uses for `userData`. */
  readonly userDataDirName: string;
  readonly appUserModelId: string;
  readonly linuxExecutableName: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly macIconPng: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
  /**
   * electron-updater channel, and therefore the manifest asset name
   * (`<updateChannel>-mac.yml`) and the version's first prerelease identifier.
   *
   * This is what keeps the two apps apart inside one release repository.
   * `GitHubProvider.getLatestVersion` walks the releases feed and takes the
   * first release whose `semver.prerelease(tag)[0]` equals the running app's
   * channel, so a staging build is invisible to a production app and vice
   * versa. See `scripts/lib/bk-desktop-release.ts` for the version format.
   */
  readonly updateChannel: string;
  /**
   * OS-level URL scheme this app registers as a handler for, or `null` to
   * register none.
   *
   * Two installed apps both claiming `t3code://` is not a tie macOS breaks
   * predictably — it routes to whichever became the handler most recently — so a
   * staging pairing link could open production. State stays isolated either way,
   * but to a user it is indistinguishable from channel leakage.
   *
   * Staging therefore registers nothing, which leaves `t3code://` unambiguously
   * with production (or upstream). It pairs by pasting the credential into the
   * pairing screen, which already accepts one: see `PairingRouteSurface` and
   * `fork/managedPrimaryPairing.ts`.
   *
   * Deliberately *not* "give staging its own scheme": `getDesktopScheme` in
   * `apps/desktop/src/electron/ElectronProtocol.ts` is also the origin the
   * renderer is served from, and `apps/server/src/http.ts` allowlists
   * `t3code://app` for CORS. Registering a different OS handler is a one-line
   * manifest change; changing the serving origin is not.
   */
  readonly deepLinkScheme: string | null;
}

/**
 * BK icon sources. These live in the fork-owned `assets/bk/` directory rather
 * than in `BRAND_ASSET_PATHS`, because widening that file's `WebAssetBrand`
 * union would type-force a matching set of web favicons the fork's hosted app
 * does not use.
 */
export const BK_BRAND_ASSET_PATHS = {
  macIconPng: "assets/bk/bk-macos-1024.png",
  universalIconPng: "assets/bk/bk-universal-1024.png",
  windowsIconIco: "assets/bk/bk-windows.ico",
} as const;

export const BK_DESKTOP_BRANDS: Readonly<Record<BkDesktopVariant, DesktopBrand>> = {
  production: {
    id: "bk",
    variant: "production",
    appId: "work.beknown.bkt3code",
    productName: "BK T3 Code",
    displayName: "BK T3 Code",
    artifactName: "BK-T3-Code-${version}-${arch}.${ext}",
    userDataDirName: "bkt3code",
    appUserModelId: "work.beknown.bkt3code",
    linuxExecutableName: "bkt3code",
    linuxDesktopEntryName: "bkt3code.desktop",
    linuxWmClass: "bkt3code",
    macIconPng: BK_BRAND_ASSET_PATHS.macIconPng,
    linuxIconPng: BK_BRAND_ASSET_PATHS.universalIconPng,
    windowsIconIco: BK_BRAND_ASSET_PATHS.windowsIconIco,
    updateChannel: "production-nightly",
    deepLinkScheme: "t3code",
  },
  staging: {
    id: "bk",
    variant: "staging",
    appId: "work.beknown.bkt3code.staging",
    // "Stage BK T3 Code", not "BK T3 Code (Staging)": this is the name already
    // installed on the team's Macs. productName derives the .app bundle name and
    // Electron's default data directory, so renaming it after rollout leaves a
    // duplicate application and an orphaned state directory behind.
    productName: "Stage BK T3 Code",
    displayName: "Stage BK T3 Code",
    artifactName: "Stage-BK-T3-Code-${version}-${arch}.${ext}",
    userDataDirName: "bkt3code-staging",
    appUserModelId: "work.beknown.bkt3code.staging",
    linuxExecutableName: "bkt3code-staging",
    linuxDesktopEntryName: "bkt3code-staging.desktop",
    linuxWmClass: "bkt3code-staging",
    macIconPng: BK_BRAND_ASSET_PATHS.macIconPng,
    linuxIconPng: BK_BRAND_ASSET_PATHS.universalIconPng,
    windowsIconIco: BK_BRAND_ASSET_PATHS.windowsIconIco,
    updateChannel: "staging-nightly",
    deepLinkScheme: null,
  },
};

/**
 * The production brand.
 *
 * Kept as a named export because it is the identity the fork has shipped since
 * the first DMG, and `docs/operations/bk-desktop-build.md` documents it.
 */
export const BK_DESKTOP_BRAND: DesktopBrand = BK_DESKTOP_BRANDS[BK_DESKTOP_DEFAULT_VARIANT];

export function isBkDesktopBrandId(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === BK_DESKTOP_BRAND_ID;
}

/** Resolves the brand from a build environment, defaulting to upstream. */
export function resolveDesktopBrandId(
  env: Readonly<Record<string, string | undefined>>,
): DesktopBrandId {
  return isBkDesktopBrandId(env[DESKTOP_BRAND_ENV_VAR]) ? "bk" : "upstream";
}

/**
 * Resolves which fork app a build produces.
 *
 * Reuses {@link BK_MANAGED_CHANNEL_ENV_VAR} rather than adding a second switch:
 * the app's identity and the central server it orchestrates are the same
 * decision, and letting them disagree is how you ship a "staging" app pointed at
 * production. Unlike `resolveBkManagedEnvironment`, an unrecognised value falls
 * back to the default here instead of throwing — the managed-environment
 * resolver is the one that owns that error, and it runs on the same variable.
 */
export function resolveBkDesktopVariant(
  env: Readonly<Record<string, string | undefined>>,
): BkDesktopVariant {
  const raw = env[BK_MANAGED_CHANNEL_ENV_VAR]?.trim().toLowerCase();
  return isBkManagedChannel(raw) ? raw : BK_DESKTOP_DEFAULT_VARIANT;
}

/**
 * Returns the fork brand when selected, otherwise `undefined` so callers fall
 * back to their existing upstream behaviour.
 */
export function resolveBkDesktopBrand(
  env: Readonly<Record<string, string | undefined>>,
): DesktopBrand | undefined {
  return resolveDesktopBrandId(env) === "bk"
    ? BK_DESKTOP_BRANDS[resolveBkDesktopVariant(env)]
    : undefined;
}
