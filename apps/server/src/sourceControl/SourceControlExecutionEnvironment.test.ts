import { assert, describe, it } from "@effect/vitest";

import {
  mergeSourceControlEnvironment,
  scrubSourceControlIdentityEnvironment,
} from "./SourceControlExecutionEnvironment.ts";

describe("SourceControlExecutionEnvironment", () => {
  it("removes inherited GitHub, author, SSH, and dynamic Git config values", () => {
    const scrubbed = scrubSourceControlIdentityEnvironment({
      PATH: "/bin",
      GH_TOKEN: "machine-token",
      GITHUB_TOKEN: "machine-github-token",
      GIT_AUTHOR_NAME: "Machine User",
      GIT_COMMITTER_EMAIL: "machine@example.test",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "store",
      GIT_SSH_COMMAND: "ssh -i shared-key",
    });

    assert.deepStrictEqual(scrubbed, { PATH: "/bin" });
  });

  it("lets the thread profile win while preserving unrelated provider variables", () => {
    const merged = mergeSourceControlEnvironment(
      { PATH: "/bin", PROVIDER_KEY: "provider", GH_TOKEN: "machine" },
      {
        GH_TOKEN: "alice-token",
        GIT_AUTHOR_NAME: "Alice",
        GIT_AUTHOR_EMAIL: "alice@users.noreply.github.com",
      },
    );

    assert.equal(merged.PATH, "/bin");
    assert.equal(merged.PROVIDER_KEY, "provider");
    assert.equal(merged.GH_TOKEN, "alice-token");
    assert.equal(merged.GIT_AUTHOR_NAME, "Alice");
  });

  // T3-CUSTOM(expbkt3): the session-identity markers are an additive overlay,
  // so machine-identity mode must keep the machine's own credentials.
  it("keeps inherited source-control credentials under an additive overlay", () => {
    const merged = mergeSourceControlEnvironment(
      { PATH: "/bin", GH_TOKEN: "machine", GIT_AUTHOR_NAME: "Machine User" },
      { BK_IDENTITY_RUNTIME: "t3-code", BK_SESSION_OWNER_EMAIL: "alice@example.com" },
    );

    assert.deepStrictEqual(merged, {
      PATH: "/bin",
      GH_TOKEN: "machine",
      GIT_AUTHOR_NAME: "Machine User",
      BK_IDENTITY_RUNTIME: "t3-code",
      BK_SESSION_OWNER_EMAIL: "alice@example.com",
    });
  });

  it("still replaces machine credentials when the overlay carries an identity", () => {
    const merged = mergeSourceControlEnvironment(
      { PATH: "/bin", GH_TOKEN: "machine", GIT_CONFIG_KEY_0: "credential.helper" },
      {
        GH_TOKEN: "alice-token",
        GIT_AUTHOR_NAME: "Alice",
        BK_IDENTITY_RUNTIME: "t3-code",
      },
    );

    assert.deepStrictEqual(merged, {
      PATH: "/bin",
      GH_TOKEN: "alice-token",
      GIT_AUTHOR_NAME: "Alice",
      BK_IDENTITY_RUNTIME: "t3-code",
    });
  });
});
