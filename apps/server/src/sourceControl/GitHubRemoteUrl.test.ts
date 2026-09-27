import { assert, describe, it } from "@effect/vitest";

import { githubSshRemoteToHttps, isGitHubSshRemote } from "./GitHubRemoteUrl.ts";

describe("GitHubRemoteUrl", () => {
  it("converts GitHub SCP and SSH remotes without embedding credentials", () => {
    assert.equal(
      githubSshRemoteToHttps("git@github.com:beknown-work/t3code.git"),
      "https://github.com/beknown-work/t3code.git",
    );
    assert.equal(
      githubSshRemoteToHttps("ssh://git@github.com/beknown-work/t3code"),
      "https://github.com/beknown-work/t3code.git",
    );
    assert.equal(
      githubSshRemoteToHttps("ssh://git@ssh.github.com:443/beknown-work/t3code.git"),
      "https://github.com/beknown-work/t3code.git",
    );
  });

  it("does not rewrite HTTPS or unrelated SSH remotes", () => {
    assert.equal(githubSshRemoteToHttps("https://github.com/acme/repo.git"), null);
    assert.equal(githubSshRemoteToHttps("git@gitlab.com:acme/repo.git"), null);
    assert.isFalse(isGitHubSshRemote("git@gitlab.com:acme/repo.git"));
  });
});
