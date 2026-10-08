// T3-CUSTOM(expbkt3): per-user source-control profiles carry their own GitHub token.
//
// A thread that runs under a profile (SourceControlProfileService) has a
// CurrentSourceControlExecutionEnvironment whose environment holds that profile's GH_TOKEN.
// Before upstream moved GitHub reads to its API transport, gh inherited that environment, so
// every read and write acted as the profile's account. These helpers keep that: the profile's
// token wins over the host's (Settings, machine env, gh), is never cached across profiles, and
// request batches never mix two profiles.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
  carriesSourceControlIdentity,
  CurrentSourceControlExecutionEnvironment,
  type SourceControlExecutionEnvironment,
} from "./SourceControlExecutionEnvironment.ts";

/**
 * The current profile environment when it replaces the machine's GitHub identity, else null.
 * An overlay with no identity of its own (session markers only) keeps the host credential.
 */
export const currentGitHubProfileEnvironment: Effect.Effect<
  SourceControlExecutionEnvironment | null
> = Effect.gen(function* () {
  const execution = yield* CurrentSourceControlExecutionEnvironment;
  return execution !== null && carriesSourceControlIdentity(execution.environment)
    ? execution
    : null;
});

/**
 * The token material a profile credential is fingerprinted from. Including the profile keeps
 * its rate-limit and quota scope, and every cache keyed by the fingerprint, apart from any
 * other profile or the machine, even when two of them hold the same token.
 */
export function gitHubProfileFingerprintMaterial(
  profile: SourceControlExecutionEnvironment,
  token: string,
): string {
  return `source-control-profile\u0000${profile.profileId}\u0000${token}`;
}

/** A request batch key part, so lookups made under different profiles never share a batch. */
export function gitHubProfileBatchKey<R>(context: Context.Context<R>): string {
  return (
    Context.getOrElse(context, CurrentSourceControlExecutionEnvironment, () => null)?.profileId ??
    ""
  );
}
