// T3-CUSTOM(expbkt3): per-environment nickname, icon and colour on mobile.
//
// The override is the host's `environmentAppearance` server setting, shared
// with everyone connected to it, read from each environment's live server
// config. Resolved against the connection's label and an id-derived fallback,
// so a machine shows the same badge here as it does in the browser.
import {
  environmentAppearanceFromSettings,
  environmentAppearanceSettingValue,
  type EnvironmentAppearance,
} from "@t3tools/client-runtime/state/environment-appearance";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveMobileEnvironmentAppearance,
  type MobileEnvironmentAppearance,
} from "./environmentAppearance";

/** Appearance for every known environment, keyed by id. */
export function useEnvironmentAppearances(): ReadonlyMap<string, MobileEnvironmentAppearance> {
  const { environments } = useEnvironments();
  return useMemo(
    () =>
      new Map(
        environments.map((environment) => [
          environment.environmentId,
          resolveMobileEnvironmentAppearance({
            environmentId: environment.environmentId,
            label: environment.label,
            appearance: environmentAppearanceFromSettings(environment.serverConfig?.settings),
          }),
        ]),
      ),
    [environments],
  );
}

export function useEnvironmentAppearance(
  environmentId: EnvironmentId | null,
): MobileEnvironmentAppearance | null {
  const appearances = useEnvironmentAppearances();
  return environmentId === null ? null : (appearances.get(environmentId) ?? null);
}

/**
 * Why the editor is inert, or null when it can be changed. The server still
 * rejects a write from a session without the operate scope; that failure is
 * reported like any other settings write.
 */
export function useEnvironmentAppearanceLock(environmentId: EnvironmentId): string | null {
  const { environments } = useEnvironments();
  const serverConfig =
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig ??
    null;
  if (serverConfig === null) return "Connect to this environment to change its appearance.";
  if (serverConfig.environment.capabilities.environmentAppearance !== true) {
    return "This environment's server is too old to keep an appearance. Update it to set one.";
  }
  return null;
}

/** The host's stored override, for the editor's own state. */
export function useStoredEnvironmentAppearance(
  environmentId: EnvironmentId,
): EnvironmentAppearance | undefined {
  const { environments } = useEnvironments();
  return environmentAppearanceFromSettings(
    environments.find((environment) => environment.environmentId === environmentId)?.serverConfig
      ?.settings,
  );
}

/**
 * Write one host's appearance to its server settings. Passing null clears it,
 * so the derived default shows again for everyone on that host.
 */
export function useUpdateEnvironmentAppearance(): (
  environmentId: EnvironmentId,
  appearance: EnvironmentAppearance | null,
) => void {
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "environment appearance update",
    reportFailure: true,
  });
  return useCallback(
    (environmentId, appearance) => {
      void updateSettings({
        environmentId,
        input: {
          patch: {
            environmentAppearance:
              appearance === null ? null : environmentAppearanceSettingValue(appearance),
          },
        },
      });
    },
    [updateSettings],
  );
}
