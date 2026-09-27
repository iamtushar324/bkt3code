/**
 * Fork-owned runtime brand for the packaged desktop app.
 *
 * The brand is chosen at build time (`T3CODE_BRAND=bk`) and baked into the
 * bundle by `apps/desktop/vite.config.ts` as `__T3CODE_BUILD_BRAND__`. It cannot
 * be read from `process.env` at runtime, because nothing sets that variable on a
 * user's machine — the same reason the Clerk publishable key is baked in via
 * `__T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__` (see `../app/DesktopClerk.ts`).
 *
 * Which of the two fork apps this is — staging (from `expbkmain`) or production
 * (from `bkmain`) — is baked in the same way, as
 * `__T3CODE_BUILD_BRAND_VARIANT__`.
 *
 * The values here must stay in sync with `scripts/lib/bk-desktop-brand.ts`,
 * which is what the packager writes into the app bundle. `BkBrand.test.ts`
 * asserts that.
 */

declare const __T3CODE_BUILD_BRAND__: string | undefined;
declare const __T3CODE_BUILD_BRAND_VARIANT__: string | undefined;

export type BkRuntimeVariant = "staging" | "production";

export interface BkRuntimeBrand {
  readonly variant: BkRuntimeVariant;
  readonly baseName: string;
  readonly displayName: string;
  readonly userDataDirName: string;
  /**
   * Must stay fork-specific, and distinct per variant. `resolveUserDataPath` in
   * `../app/DesktopAppIdentity.ts` prefers the legacy directory whenever it
   * exists, so inheriting upstream's "T3 Code (Alpha)" would make a fork build
   * adopt an installed upstream app's settings, saved environments and sessions
   * — and sharing one legacy name across the two fork apps would make staging
   * adopt production's. This is the productName-derived directory Electron would
   * default to, which is each app's own equivalent of the upstream migration.
   */
  readonly legacyUserDataDirName: string;
  readonly appUserModelId: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  /**
   * electron-updater channel this app follows. Handed to `setChannel` in
   * `../updates/DesktopUpdates.ts`; see `scripts/lib/bk-desktop-brand.ts` for
   * why it is what separates the two apps' updates.
   */
  readonly updateChannel: string;
  /**
   * OS-level URL scheme this app registers, or `null` for none. Staging
   * registers none so `t3code://` stays unambiguously production's; see
   * `scripts/lib/bk-desktop-brand.ts`.
   */
  readonly deepLinkScheme: string | null;
}

/** Identity applied when the fork brand is active, one per app. */
export const BK_RUNTIME_BRANDS: Readonly<Record<BkRuntimeVariant, BkRuntimeBrand>> = {
  production: {
    variant: "production",
    baseName: "BK T3 Code",
    displayName: "BK T3 Code",
    userDataDirName: "bkt3code",
    legacyUserDataDirName: "BK T3 Code",
    appUserModelId: "work.beknown.bkt3code",
    linuxDesktopEntryName: "bkt3code.desktop",
    linuxWmClass: "bkt3code",
    updateChannel: "production-nightly",
    deepLinkScheme: "t3code",
  },
  staging: {
    variant: "staging",
    baseName: "Stage BK T3 Code",
    displayName: "Stage BK T3 Code",
    userDataDirName: "bkt3code-staging",
    legacyUserDataDirName: "Stage BK T3 Code",
    appUserModelId: "work.beknown.bkt3code.staging",
    linuxDesktopEntryName: "bkt3code-staging.desktop",
    linuxWmClass: "bkt3code-staging",
    updateChannel: "staging-nightly",
    deepLinkScheme: null,
  },
};

/** Variant used when the define is absent or unrecognised. */
const DEFAULT_RUNTIME_VARIANT: BkRuntimeVariant = "production";

/** The production identity, which is what an unqualified fork build produces. */
export const BK_RUNTIME_BRAND = BK_RUNTIME_BRANDS[DEFAULT_RUNTIME_VARIANT];

/**
 * True when this bundle was packaged with the fork brand.
 *
 * The `typeof` guard matters: the define is absent under `vitest` and in the
 * unbundled dev run, where the identifier would otherwise throw a ReferenceError.
 */
export function isBkBrandBuild(): boolean {
  return typeof __T3CODE_BUILD_BRAND__ !== "undefined" && __T3CODE_BUILD_BRAND__ === "bk";
}

function resolveBuildVariant(): BkRuntimeVariant {
  if (typeof __T3CODE_BUILD_BRAND_VARIANT__ === "undefined") return DEFAULT_RUNTIME_VARIANT;
  return __T3CODE_BUILD_BRAND_VARIANT__ === "staging" ? "staging" : DEFAULT_RUNTIME_VARIANT;
}

/** The fork brand when active, otherwise `undefined` for upstream behaviour. */
export function resolveRuntimeBrand(): BkRuntimeBrand | undefined {
  return isBkBrandBuild() ? BK_RUNTIME_BRANDS[resolveBuildVariant()] : undefined;
}
