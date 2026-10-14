/**
 * T3-CUSTOM(expbkt3): product analytics config handed to clients (TEC-1631).
 *
 * The web and desktop clients send their own PostHog events, to the same
 * company project the server reports to. They learn the key from the
 * environment descriptor at runtime, so no key is baked into the bundle and
 * each environment decides for itself.
 *
 * Only an explicitly set `T3CODE_POSTHOG_KEY` is advertised. The server's own
 * telemetry falls back to upstream's project key; clients must never send
 * Beknown usage there, so with no explicit key the field is absent and the
 * client stays off.
 *
 * @module clientAnalyticsConfig
 */
import type { ExecutionEnvironmentAnalytics } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

const ClientAnalyticsEnvConfig = Config.all({
  posthogKey: Config.String("T3CODE_POSTHOG_KEY").pipe(Config.option),
  posthogHost: Config.String("T3CODE_POSTHOG_HOST").pipe(Config.option),
  enabled: Config.Boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  instance: Config.String("T3CODE_ANALYTICS_INSTANCE").pipe(Config.option),
});

function nonEmpty(value: Option.Option<string>): string | null {
  const trimmed = Option.getOrNull(value)?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Pure mapping from env values to the descriptor field; `null` means omit it. */
export function resolveClientAnalyticsConfig(input: {
  readonly posthogKey: Option.Option<string>;
  readonly posthogHost: Option.Option<string>;
  readonly enabled: boolean;
  readonly instance: Option.Option<string>;
}): ExecutionEnvironmentAnalytics | null {
  const posthogKey = nonEmpty(input.posthogKey);
  if (!input.enabled || posthogKey === null) return null;
  const instance = nonEmpty(input.instance);
  return {
    enabled: true,
    posthogKey,
    posthogHost: nonEmpty(input.posthogHost) ?? DEFAULT_POSTHOG_HOST,
    ...(instance === null ? {} : { instance }),
  };
}

/** Reads the env once; a bad value disables client analytics, never the server. */
export const loadClientAnalyticsConfig: Effect.Effect<ExecutionEnvironmentAnalytics | null> =
  Effect.gen(function* () {
    return resolveClientAnalyticsConfig(yield* ClientAnalyticsEnvConfig);
  }).pipe(Effect.orElseSucceed(() => null));
