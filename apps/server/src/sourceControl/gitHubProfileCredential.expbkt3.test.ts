// T3-CUSTOM(expbkt3): a source-control profile's token wins over the host's, per profile.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SourceControlProfileId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import { withSourceControlExecutionEnvironment } from "./SourceControlExecutionEnvironment.ts";

function harness(tokens: Record<string, string> = {}) {
  const calls: Array<ReadonlyArray<string>> = [];
  const process = Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input.args);
        return {
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "machine-token\n",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const layer = GitHubCredentials.layer.pipe(
    Layer.provideMerge(
      ServerSettings.ServerSettingsService.layerTest({ github: { hosts: {}, tokens } }),
    ),
    Layer.provide(process),
    Layer.provide(NodeServices.layer),
  );
  return { layer, calls };
}

const asProfile = <A, E, R>(effect: Effect.Effect<A, E, R>, profileId: string, token?: string) =>
  withSourceControlExecutionEnvironment(effect, {
    profileId: SourceControlProfileId.make(profileId),
    environment:
      token === undefined ? { GH_CONFIG_DIR: `/profiles/${profileId}` } : { GH_TOKEN: token },
  });

describe("GitHubCredentials under a source-control profile", () => {
  it.effect("uses the profile's token ahead of a saved token and gh", () => {
    const { layer, calls } = harness({ "github.com": "saved-token" });
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const alice = yield* asProfile(credentials.get("github.com"), "alice", "alice-token");
      const bob = yield* asProfile(credentials.get("github.com"), "bob", "bob-token");
      const machine = yield* credentials.get("github.com");
      expect(Redacted.value(alice.token)).toBe("alice-token");
      expect(Redacted.value(bob.token)).toBe("bob-token");
      expect(Redacted.value(machine.token)).toBe("saved-token");
      expect(new Set([alice.fingerprint, bob.fingerprint, machine.fingerprint]).size).toBe(3);
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps two profiles with the same token in separate scopes", () => {
    const { layer } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const alice = yield* asProfile(credentials.get("github.com"), "alice", "shared-token");
      const bob = yield* asProfile(credentials.get("github.com"), "bob", "shared-token");
      expect(alice.fingerprint).not.toBe(bob.fingerprint);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never falls back to the machine's credential for a profile without a token", () => {
    const { layer, calls } = harness();
    return Effect.gen(function* () {
      const credentials = yield* GitHubCredentials.GitHubCredentials;
      const error = yield* Effect.flip(asProfile(credentials.get("github.com"), "alice"));
      expect(error._tag).toBe("GitHubNotSignedInError");
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
