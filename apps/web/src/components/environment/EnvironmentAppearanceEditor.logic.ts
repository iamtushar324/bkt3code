// T3-CUSTOM(expbkt3): when the host appearance editor is inert. Same order as
// upstream's icon picker (resolveEnvironmentIconPickerLock), keyed on the
// appearance capability instead of the icon one.
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";

/** Why the editor is inert, or null when it can be changed. */
export function resolveEnvironmentAppearanceLock(input: {
  readonly serverConfig: EnvironmentServerConfig | null;
  readonly operateAccess: "granted" | "denied" | "pending";
}): string | null {
  if (input.serverConfig === null) {
    return "Connect to this environment to change its appearance.";
  }
  if (input.serverConfig.environment.capabilities.environmentAppearance !== true) {
    return "This environment's server is too old to keep an appearance. Update it to set one.";
  }
  if (input.operateAccess === "denied") {
    return "Your session on this environment cannot change its settings.";
  }
  return null;
}
