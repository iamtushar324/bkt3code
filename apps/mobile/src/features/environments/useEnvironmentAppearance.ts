// T3-CUSTOM(expbkt3): per-environment icon and colour on mobile, read-only.
//
// Derived from the environment id and the connection's label, so a machine
// shows the same badge here as it does in the browser.
import { useMemo } from "react";

import { useEnvironments } from "../../state/environments";
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
          }),
        ]),
      ),
    [environments],
  );
}
