/**
 * T3-CUSTOM(expbkt3): the server's analytics settings stay in the server.
 *
 * Agent processes (provider CLIs, and every tool or dev server they start)
 * must not inherit the PostHog key or instance name: an agent could read the
 * key, and a dev server it starts would report into the production project
 * as the production instance.
 *
 * The keys are set to `undefined` rather than deleted. Some spawns use
 * `extendEnv: true`, which spreads `process.env` under the given env, and only
 * an explicit `undefined` hides the inherited value there. Node drops
 * `undefined` entries when it builds the child's environment.
 */

export const SERVER_ANALYTICS_ENV_KEYS = [
  "T3CODE_POSTHOG_KEY",
  "T3CODE_POSTHOG_HOST",
  "T3CODE_ANALYTICS_INSTANCE",
  "T3CODE_TELEMETRY_ENABLED",
] as const;

/**
 * `env` with every analytics key the child could see (from `env` itself or
 * from `inherited`, the server's own environment) masked. Returns `env`
 * unchanged when no such key is set anywhere.
 */
export function withoutAnalyticsEnvironment(
  env: NodeJS.ProcessEnv,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
  const present = SERVER_ANALYTICS_ENV_KEYS.filter(
    (key) => env[key] !== undefined || inherited[key] !== undefined,
  );
  if (present.length === 0) return env;
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of present) next[key] = undefined;
  return next;
}
