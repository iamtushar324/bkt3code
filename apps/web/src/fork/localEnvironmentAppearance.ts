/**
 * T3-CUSTOM(expbkt3): the default look for the computer this client runs on.
 *
 * Remote hosts get a look derived from their id. The local backend instead starts
 * as "local", a blue laptop, so it reads as "here" among them; its nickname, icon
 * and colour stay editable like any host's, and "Reset to default" returns here.
 *
 * "This computer" is the desktop app's own backend: the primary environment in an
 * upstream desktop build, or a desktop-local backend registered as a `local:`
 * secondary (how a managed BK build, whose primary is the central server, would
 * attach one). WSL backends keep their derived look so they stay distinguishable
 * from it. A browser tab has no local backend, so nothing is "local" there.
 *
 * @module fork/localEnvironmentAppearance
 */
import type { ConnectionTarget } from "@t3tools/client-runtime/connection";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import {
  LOCAL_ENVIRONMENT_APPEARANCE_DEFAULTS,
  type EnvironmentAppearanceDefaults,
} from "../state/environmentAppearance";
import { isBkManagedPrimary } from "./managedEnvironment";

export function isThisComputerEnvironment(
  target: ConnectionTarget,
  context: { readonly hasDesktopBridge: boolean; readonly managedPrimary: boolean },
): boolean {
  if (!context.hasDesktopBridge) return false;
  if (target._tag === "PrimaryConnectionTarget") return !context.managedPrimary;
  return isDesktopLocalConnectionTarget(target) && !isWslConnectionTarget(target);
}

export function localEnvironmentAppearanceDefaults(
  target: ConnectionTarget,
): EnvironmentAppearanceDefaults | undefined {
  const isLocal = isThisComputerEnvironment(target, {
    hasDesktopBridge: typeof window !== "undefined" && window.desktopBridge !== undefined,
    managedPrimary: isBkManagedPrimary(),
  });
  return isLocal ? LOCAL_ENVIRONMENT_APPEARANCE_DEFAULTS : undefined;
}
