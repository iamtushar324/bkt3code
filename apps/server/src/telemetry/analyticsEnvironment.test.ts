// T3-CUSTOM(expbkt3): agent processes never see the server's analytics settings (TEC-1631).
import { assert, it } from "@effect/vitest";

import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { SERVER_ANALYTICS_ENV_KEYS, withoutAnalyticsEnvironment } from "./analyticsEnvironment.ts";

const serverEnv = {
  PATH: "/usr/bin",
  T3CODE_POSTHOG_KEY: "phc_secret",
  T3CODE_POSTHOG_HOST: "https://eu.i.posthog.com",
  T3CODE_ANALYTICS_INSTANCE: "bkt3",
  T3CODE_TELEMETRY_ENABLED: "true",
};

/** What a child sees when the spawner spreads the server env under `env` (`extendEnv: true`). */
const childSees = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries({ ...serverEnv, ...env }).filter(([, value]) => value !== undefined),
  );

it("masks every analytics key from an env built on the server's env", () => {
  const masked = withoutAnalyticsEnvironment({ ...serverEnv, CODEX_HOME: "/codex" }, serverEnv);
  for (const key of SERVER_ANALYTICS_ENV_KEYS) {
    assert.isTrue(key in masked, key);
    assert.isUndefined(masked[key], key);
  }
  assert.equal(masked.PATH, "/usr/bin");
  assert.equal(masked.CODEX_HOME, "/codex");
});

it("hides inherited keys even when the spawner extends the server env", () => {
  // The env passed to the child does not carry the keys, but the server's does.
  const masked = withoutAnalyticsEnvironment({ CODEX_HOME: "/codex" }, serverEnv);
  assert.deepEqual(childSees(masked), { PATH: "/usr/bin", CODEX_HOME: "/codex" });
});

it("returns the env unchanged when no analytics key is set anywhere", () => {
  const env = { PATH: "/usr/bin" };
  assert.strictEqual(withoutAnalyticsEnvironment(env, { HOME: "/home/u" }), env);
});

it("does not mutate the env it was given", () => {
  const env = { ...serverEnv };
  withoutAnalyticsEnvironment(env, {});
  assert.equal(env.T3CODE_POSTHOG_KEY, "phc_secret");
});

it("strips the keys from every provider environment, with or without instance overrides", () => {
  for (const environment of [
    undefined,
    [],
    [{ name: "CUSTOM_VALUE", value: "x", sensitive: false }],
    [{ name: "T3CODE_POSTHOG_KEY", value: "phc_override", sensitive: true }],
  ]) {
    const merged = mergeProviderInstanceEnvironment(environment, serverEnv);
    for (const key of SERVER_ANALYTICS_ENV_KEYS) {
      assert.isUndefined(merged[key], key);
    }
    assert.equal(merged.PATH, "/usr/bin");
  }
});
