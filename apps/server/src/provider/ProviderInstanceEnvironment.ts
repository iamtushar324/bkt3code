import type { ProviderInstanceEnvironment } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";
// T3-CUSTOM(expbkt3): agents never inherit the server's analytics settings (TEC-1631).
import { withoutAnalyticsEnvironment } from "../telemetry/analyticsEnvironment.ts";

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return withoutAnalyticsEnvironment(baseEnv); // T3-CUSTOM(expbkt3): TEC-1631.
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value)
        : variable.value;
  }
  return withoutAnalyticsEnvironment(next); // T3-CUSTOM(expbkt3): TEC-1631.
}
