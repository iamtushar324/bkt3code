import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeGitStateFingerprints, splitGitConfig } from "./gitStateFingerprint.expbkt3.ts";

const repositoryConfig = (branchSections: string) =>
  [
    "[core]",
    "\trepositoryformatversion = 0",
    '[remote "origin"]',
    "\turl = git@github.com:owner/repository.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    branchSections,
  ].join("\n");

describe("splitGitConfig", () => {
  it("keeps another branch's section out of this branch and the shared part", () => {
    const own = '[branch "feature/a"]\n\tremote = origin\n\tmerge = refs/heads/feature/a';
    const before = splitGitConfig(repositoryConfig(own));
    const after = splitGitConfig(
      repositoryConfig(`${own}\n[branch "feature/b"]\n\tremote = origin`),
    );

    expect(after?.shared).toBe(before?.shared);
    expect(after?.branches.get("feature/a")).toBe(before?.branches.get("feature/a"));
    expect(after?.remoteNames).toEqual(["origin"]);
  });

  it("reads section names case-insensitively and unescapes subsections", () => {
    const split = splitGitConfig(
      '[Remote "up\\"stream"]\n\turl = x\n[BRANCH "main"]\n\tremote = x',
    );

    expect(split?.remoteNames).toEqual(['up"stream']);
    expect(split?.branches.get("main")).toContain("remote = x");
  });

  it("gives up on syntax whose dependencies it cannot follow", () => {
    expect(splitGitConfig("[include]\n\tpath = shared.config")).toBeNull();
    expect(splitGitConfig('[includeIf "gitdir:~/work/"]\n\tpath = work.config')).toBeNull();
    expect(splitGitConfig('[core]\n\teditor = vim \\\n[branch "x"]')).toBeNull();
    expect(splitGitConfig('[branch "x"] remote = origin')).toBeNull();
  });
});

it.layer(NodeServices.layer)("git state fingerprint", (it) => {
  // A linked worktree laid out as git writes it, without running git.
  const linkedWorktree = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-git-fingerprint-" });
    const commonDir = path.join(root, "repository", ".git");
    const gitDir = path.join(commonDir, "worktrees", "linked");
    const worktree = path.join(root, "linked");
    for (const directory of [
      gitDir,
      worktree,
      path.join(commonDir, "refs", "heads", "feature"),
      path.join(commonDir, "refs", "remotes", "origin", "feature"),
    ]) {
      yield* fileSystem.makeDirectory(directory, { recursive: true });
    }
    yield* fileSystem.writeFileString(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
    yield* fileSystem.writeFileString(path.join(gitDir, "commondir"), "../..\n");
    yield* fileSystem.writeFileString(path.join(gitDir, "HEAD"), "ref: refs/heads/feature/a\n");
    yield* fileSystem.writeFileString(
      path.join(commonDir, "config"),
      repositoryConfig('[branch "feature/a"]\n\tremote = origin'),
    );
    const sha = "0123456789abcdef0123456789abcdef01234567\n";
    yield* fileSystem.writeFileString(path.join(commonDir, "refs", "heads", "feature", "a"), sha);
    const remoteRef = path.join(commonDir, "refs", "remotes", "origin", "feature", "a");
    yield* fileSystem.writeFileString(remoteRef, sha);
    const fingerprints = yield* makeGitStateFingerprints({ fileSystem, path });
    return { fileSystem, path, commonDir, worktree, remoteRef, fingerprints };
  });

  it.effect("follows the branch's own config section and refs, not other branches", () =>
    Effect.gen(function* () {
      const { fileSystem, path, commonDir, worktree, remoteRef, fingerprints } =
        yield* linkedWorktree;
      const configPath = path.join(commonDir, "config");
      const initial = yield* fingerprints.read(worktree, "feature/a");
      expect(initial).not.toBeNull();
      expect(yield* initial!.unchanged).toBe(true);

      yield* fileSystem.writeFileString(
        configPath,
        repositoryConfig('[branch "feature/a"]\n\tremote = origin\n[branch "other"]\n\tmerge = x'),
      );
      yield* fileSystem.utimes(configPath, 1_700_000_000, 1_700_000_000);
      const otherBranch = yield* fingerprints.read(worktree, "feature/a");
      expect(yield* initial!.unchanged).toBe(false);
      expect(otherBranch?.branch).toBe(initial?.branch);

      yield* fileSystem.writeFileString(
        configPath,
        repositoryConfig(
          '[branch "feature/a"]\n\tremote = upstream\n[branch "other"]\n\tmerge = x',
        ),
      );
      yield* fileSystem.utimes(configPath, 1_700_000_100, 1_700_000_100);
      const ownBranch = yield* fingerprints.read(worktree, "feature/a");
      expect(ownBranch?.repository).toBe(initial?.repository);
      expect(ownBranch?.branch).not.toBe(initial?.branch);

      yield* fileSystem.utimes(remoteRef, 1_700_000_200, 1_700_000_200);
      const pushed = yield* fingerprints.read(worktree, "feature/a");
      expect(pushed?.repository).toBe(initial?.repository);
      expect(pushed?.branch).not.toBe(ownBranch?.branch);
    }),
  );

  it.effect("has no fingerprint for reftable repositories or folders without .git", () =>
    Effect.gen(function* () {
      const { fileSystem, path, commonDir, worktree, fingerprints } = yield* linkedWorktree;
      expect(yield* fingerprints.read(path.join(worktree, "nested"), "feature/a")).toBeNull();

      yield* fileSystem.makeDirectory(path.join(commonDir, "reftable"));
      expect(yield* fingerprints.read(worktree, "feature/a")).toBeNull();
    }),
  );
});
