import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { SourceControlProfileId } from "@t3tools/contracts";

export const RESERVED_SOURCE_CONTROL_ENVIRONMENT_KEYS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_CONFIG_DIR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_COUNT",
  "GIT_SSH_COMMAND",
]);

export interface SourceControlExecutionEnvironment {
  readonly profileId: SourceControlProfileId;
  readonly environment: NodeJS.ProcessEnv;
}

export const CurrentSourceControlExecutionEnvironment =
  Context.Reference<SourceControlExecutionEnvironment | null>(
    "t3/sourceControl/CurrentSourceControlExecutionEnvironment",
    { defaultValue: () => null },
  );

export function scrubSourceControlIdentityEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next = { ...environment };
  for (const key of RESERVED_SOURCE_CONTROL_ENVIRONMENT_KEYS) {
    delete next[key];
  }
  for (const key of Object.keys(next)) {
    if (key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      delete next[key];
    }
  }
  return next;
}

export function carriesSourceControlIdentity(environment: NodeJS.ProcessEnv): boolean {
  return Object.keys(environment).some(
    (key) =>
      RESERVED_SOURCE_CONTROL_ENVIRONMENT_KEYS.has(key) ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_"),
  );
}

/**
 * Scrubbing the base is how a profile's identity replaces whatever the machine
 * exported. An overlay that carries no source-control identity of its own —
 * the additive session-identity markers — has nothing to replace, so the
 * machine's own credentials have to survive it.
 */
export function mergeSourceControlEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  sourceControlEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...(carriesSourceControlIdentity(sourceControlEnvironment)
      ? scrubSourceControlIdentityEnvironment(baseEnvironment)
      : baseEnvironment),
    ...sourceControlEnvironment,
  };
}

export function withSourceControlExecutionEnvironment<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  executionEnvironment: SourceControlExecutionEnvironment | null,
): Effect.Effect<A, E, R> {
  return Effect.provideService(
    effect,
    CurrentSourceControlExecutionEnvironment,
    executionEnvironment,
  );
}
