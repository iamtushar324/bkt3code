/**
 * T3-CUSTOM(expbkt3): the central server a managed BK build orchestrates.
 *
 * A managed BK desktop build points its *primary environment* at a central
 * Beknown T3 server (bkt3 or expbkt3) instead of the backend Electron bundles.
 * That is what makes the desktop useful to the team: projects, sessions, the
 * member directory and thread tagging all live on the central server, and the
 * member picker (`state/orgMembers`) reads them through the primary HTTP
 * client.
 *
 * Two axes are easy to confuse and are deliberately kept apart here:
 *
 * - **`PRIMARY_LOCAL_ENVIRONMENT_ID`** (`"primary"`) is the *id of the
 *   desktop's local backend* in an unmanaged upstream build. Managed BK builds
 *   do not register an environment under this id.
 * - **The primary target** is *where the primary environment points*. That is
 *   what a managed build redirects.
 *
 * Managed desktop artifacts also bundle a local backend, but it never becomes
 * the primary: Electron starts it as a *secondary* desktop-local environment
 * under pool id {@link BK_BUNDLED_BACKEND_ID} (connection id `local:bk-local`).
 *
 * The value is baked in at build time by `apps/web/vite.config.ts` from
 * `scripts/lib/bk-managed-environment.ts`. It is `null` in every ordinary
 * build, and the constant is absent entirely under vitest — both mean
 * "unmanaged", so upstream behaviour is untouched.
 *
 * @module fork/managedEnvironment
 */
import { AuthAdministrativeScopes, type AuthEnvironmentScope } from "@t3tools/contracts";

import type { PrimaryEnvironmentTarget } from "../environments/primary/target";

declare const __T3CODE_BK_MANAGED_ENVIRONMENT__: unknown;

/**
 * Pool id of the backend a managed desktop bundles and starts as a secondary
 * environment. Mirrors `BK_BUNDLED_BACKEND_ID` in
 * `apps/desktop/src/branding/BkManagedEnvironment.ts`; the renderer cannot
 * import the desktop package, so the two must be changed together.
 */
export const BK_BUNDLED_BACKEND_ID = "bk-local";

export type BkManagedChannel = "staging" | "production";

export interface BkManagedEnvironment {
  readonly channel: BkManagedChannel;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/**
 * Validates the baked constant. Anything that is not a complete, well-formed
 * managed environment reads as "unmanaged" rather than throwing: a renderer
 * that refuses to boot is a worse failure than one that falls back to the local
 * backend, and the build script already rejects a bad channel at build time.
 */
export function parseBkManagedEnvironment(raw: unknown): BkManagedEnvironment | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Partial<BkManagedEnvironment>;
  if (candidate.channel !== "staging" && candidate.channel !== "production") {
    return null;
  }
  if (typeof candidate.httpBaseUrl !== "string" || candidate.httpBaseUrl.length === 0) {
    return null;
  }
  if (typeof candidate.wsBaseUrl !== "string" || candidate.wsBaseUrl.length === 0) {
    return null;
  }
  return {
    channel: candidate.channel,
    httpBaseUrl: candidate.httpBaseUrl,
    wsBaseUrl: candidate.wsBaseUrl,
  };
}

let managedEnvironmentOverride: BkManagedEnvironment | null | undefined;

function readBakedManagedEnvironment(): BkManagedEnvironment | null {
  if (typeof __T3CODE_BK_MANAGED_ENVIRONMENT__ === "undefined") {
    return null;
  }
  return parseBkManagedEnvironment(__T3CODE_BK_MANAGED_ENVIRONMENT__);
}

/** The managed environment this build targets, or `null` for every other build. */
export function readBkManagedEnvironment(): BkManagedEnvironment | null {
  return managedEnvironmentOverride ?? readBakedManagedEnvironment();
}

/** Whether the primary environment is a managed central server. */
export function isBkManagedPrimary(): boolean {
  return readBkManagedEnvironment() !== null;
}

/**
 * The primary target for a managed build.
 *
 * Reported as `"configured"` rather than a new source: the target is fixed at
 * build time, which is exactly what that source means, and widening the
 * upstream `KnownEnvironmentSource` union for a label nothing branches on would
 * cost a merge conflict for no behaviour.
 */
export function readBkManagedPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget | null {
  const managed = readBkManagedEnvironment();
  if (managed === null) {
    return null;
  }
  return {
    source: "configured",
    target: {
      httpBaseUrl: managed.httpBaseUrl,
      wsBaseUrl: managed.wsBaseUrl,
    },
  };
}

/**
 * Cache slot the connection platform keeps the *primary* registration under.
 *
 * Unmanaged, the primary registration and the bundled local backend are the
 * same thing, so upstream keys it by `PRIMARY_LOCAL_ENVIRONMENT_ID`. In a
 * managed build the bundled backend is a secondary ({@link BK_BUNDLED_BACKEND_ID})
 * and the primary is the central server, so the central primary is kept in a
 * distinct slot and cached state cannot collide during an upgrade from an
 * older build. Returns the upstream key unchanged for every other build.
 */
export function bkPrimaryRegistrationCacheKey(localEnvironmentId: string): string {
  return isBkManagedPrimary() ? "bk-managed-primary" : localEnvironmentId;
}

/**
 * Scopes the renderer asks for when it exchanges a desktop-local backend's
 * bootstrap token, or `null` to keep upstream's default.
 *
 * Upstream gives every secondary backend the standard client scopes, because a
 * WSL secondary only needs to be operated. The managed build's bundled backend
 * is the user's own Mac server, and BK Add-ons mints admin pairing links for it
 * (a phone that connects to the Mac directly), which needs `access:write`. The
 * desktop's bootstrap grant is administrative, so asking for the administrative
 * set is within what the token allows. Every other backend keeps upstream's set.
 */
export function bkBundledBackendScopes(
  backendId: string,
): ReadonlyArray<AuthEnvironmentScope> | null {
  return isBkManagedPrimary() && backendId === BK_BUNDLED_BACKEND_ID
    ? AuthAdministrativeScopes
    : null;
}

export function __setBkManagedEnvironmentForTests(value: BkManagedEnvironment | null): void {
  managedEnvironmentOverride = value ?? undefined;
}

export function __resetBkManagedEnvironmentForTests(): void {
  managedEnvironmentOverride = undefined;
}
