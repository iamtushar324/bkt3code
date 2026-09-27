/** T3-CUSTOM(expbkt3): integration coverage for codename worktree branches. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { type GitCommandError } from "@t3tools/contracts";
import { isWorktreeCodename } from "@t3tools/shared/worktreeCodename";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-worktree-naming-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "worktree-naming-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.worktreeNamingTest.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  string,
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    return yield* git(cwd, ["branch", "--show-current"]);
  });

it.layer(TestLayer)("codename worktree branch allocation", (it) => {
  it.effect("creates a branch from the same codename as its directory", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const initialBranch = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const created = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "t3code/2d633e64",
        path: null,
      });

      const codename = path.basename(created.worktree.path);
      assert.equal(isWorktreeCodename(codename), true);
      assert.equal(created.worktree.refName, `t3code/${codename}`);
      assert.equal(
        yield* git(created.worktree.path, ["branch", "--show-current"]),
        `t3code/${codename}`,
      );
    }),
  );

  it.effect("moves past a branch that exists only on a remote", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const remote = yield* makeTmpDir("worktree-naming-remote-");
      const initialBranch = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      yield* git(remote, ["init", "--bare"]);
      yield* git(cwd, ["remote", "add", "origin", remote]);

      const first = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "t3code/2d633e64",
        path: null,
      });
      const firstCodename = path.basename(first.worktree.path);
      yield* git(cwd, ["push", "origin", first.worktree.refName]);
      yield* driver.removeWorktree({ cwd, path: first.worktree.path });
      yield* git(cwd, ["branch", "-D", first.worktree.refName]);
      yield* git(cwd, ["update-ref", "-d", `refs/remotes/origin/${first.worktree.refName}`]);

      const second = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "t3code/2d633e64",
        path: null,
      });
      const secondCodename = path.basename(second.worktree.path);

      assert.notEqual(secondCodename, firstCodename);
      assert.equal(second.worktree.refName, `t3code/${secondCodename}`);
    }),
  );

  it.effect("moves to the next codename when the branch is already taken", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const initialBranch = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const first = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "t3code/2d633e64",
        path: null,
      });
      const firstCodename = path.basename(first.worktree.path);
      yield* driver.removeWorktree({ cwd, path: first.worktree.path });

      const second = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "t3code/2d633e64",
        path: null,
      });
      const secondCodename = path.basename(second.worktree.path);

      assert.notEqual(secondCodename, firstCodename);
      assert.equal(second.worktree.refName, `t3code/${secondCodename}`);
    }),
  );

  it.effect("keeps an explicitly supplied branch and path", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const initialBranch = yield* initRepoWithCommit(cwd);
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const explicitPath = path.join(yield* makeTmpDir("explicit-worktree-"), "chosen-path");

      const created = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "feature/chosen-branch",
        path: explicitPath,
      });

      assert.equal(created.worktree.path, explicitPath);
      assert.equal(created.worktree.refName, "feature/chosen-branch");
      assert.equal(yield* git(explicitPath, ["branch", "--show-current"]), "feature/chosen-branch");
    }),
  );

  it.effect("keeps an explicit branch when the directory is automatic", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTmpDir();
      const initialBranch = yield* initRepoWithCommit(cwd);
      const driver = yield* GitVcsDriver.GitVcsDriver;

      const created = yield* driver.createWorktree({
        cwd,
        refName: initialBranch,
        newRefName: "feature/chosen-branch",
        path: null,
      });

      assert.equal(created.worktree.refName, "feature/chosen-branch");
      assert.equal(
        yield* git(created.worktree.path, ["branch", "--show-current"]),
        "feature/chosen-branch",
      );
    }),
  );
});
