/**
 * Fork-owned managed-environment selection for BK desktop builds.
 *
 * A managed BK build is one whose *primary environment* is a central Beknown
 * T3 server rather than the backend Electron bundles. The team runs its
 * sessions, projects and member directory there. The bundled backend still
 * ships and starts as a *secondary* local environment, so local Mac work runs
 * on this machine — including offline — while the central server stays
 * primary.
 *
 * The URLs are selected at *build* time (`--channel` on
 * `scripts/build-bk-desktop-dmg.ts`) and baked into the renderer bundle as
 * `__T3CODE_BK_MANAGED_ENVIRONMENT__`, exactly like `__T3CODE_BUILD_BRAND__` in
 * `scripts/lib/bk-desktop-brand.ts`: nothing sets an environment variable on a
 * user's machine, so runtime lookup is not an option.
 *
 * Unset ⇒ upstream behaviour, byte for byte. There is no default channel; an
 * ordinary `vp build` produces a bundle with no managed environment at all.
 */

/** Environment variable that selects the managed channel at build time. */
export const BK_MANAGED_CHANNEL_ENV_VAR = "T3CODE_BK_MANAGED_CHANNEL";

export type BkManagedChannel = "staging" | "production";

export interface BkManagedEnvironment {
  readonly channel: BkManagedChannel;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * `staging` is expbkt3, the branch the fork ships to first; `production` is
 * bkt3, which hosts the team's live coding sessions. See AGENTS.md, "Beknown
 * fork and deployments".
 */
export const BK_MANAGED_ENVIRONMENTS: Readonly<Record<BkManagedChannel, BkManagedEnvironment>> = {
  staging: {
    channel: "staging",
    httpBaseUrl: "https://expbkt3.dev.beknown.live",
    wsBaseUrl: "wss://expbkt3.dev.beknown.live",
  },
  production: {
    channel: "production",
    httpBaseUrl: "https://bkt3.dev.beknown.live",
    wsBaseUrl: "wss://bkt3.dev.beknown.live",
  },
};

export const BK_MANAGED_CHANNELS = Object.keys(BK_MANAGED_ENVIRONMENTS) as ReadonlyArray<
  keyof typeof BK_MANAGED_ENVIRONMENTS
>;

export function isBkManagedChannel(value: string | undefined): value is BkManagedChannel {
  return value === "staging" || value === "production";
}

/**
 * Resolves the managed environment a build targets, or `undefined` for an
 * ordinary build.
 *
 * Throws on an unrecognised non-empty value rather than falling back: a typo'd
 * channel would otherwise produce a signed DMG that silently points at the
 * user's own machine, which is exactly the failure that is impossible to spot
 * from the outside.
 */
export function resolveBkManagedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): BkManagedEnvironment | undefined {
  const raw = env[BK_MANAGED_CHANNEL_ENV_VAR]?.trim().toLowerCase();
  if (!raw) {
    return undefined;
  }
  if (!isBkManagedChannel(raw)) {
    throw new Error(
      `${BK_MANAGED_CHANNEL_ENV_VAR} must be one of ${BK_MANAGED_CHANNELS.join(", ")}, got "${raw}".`,
    );
  }
  return BK_MANAGED_ENVIRONMENTS[raw];
}
