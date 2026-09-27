import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it } from "@effect/vitest";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { readSlimTrackedPathInventory, readWorktreeGitFacts } from "./gitFacts.ts";
import { decideSlimCandidate } from "./slimTargets.ts";

const gitOutput = (
  overrides: Partial<{
    readonly exitCode: ChildProcessSpawner.ExitCode;
    readonly stdout: string;
    readonly stdoutTruncated: boolean;
  }> = {},
) => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

const realGitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "session-archive-git-facts-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

describe("session archive Git inventory", () => {
  it.effect("keeps a tracked colon-prefixed filesystem candidate", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const worktreePath = NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/session-archive-git-pathspec-`);
        NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: worktreePath });
        NodeFS.mkdirSync(`${worktreePath}/:foo/dist`, { recursive: true });
        NodeFS.writeFileSync(`${worktreePath}/:foo/dist/keep.txt`, "tracked");
        NodeChildProcess.execFileSync(
          "git",
          ["--literal-pathspecs", "add", "--", ":foo/dist/keep.txt"],
          {
            cwd: worktreePath,
          },
        );
        return worktreePath;
      }),
      (worktreePath) =>
        readSlimTrackedPathInventory({ worktreePath, candidatePaths: [":foo/dist"] }),
      (worktreePath) =>
        Effect.sync(() => NodeFS.rmSync(worktreePath, { recursive: true, force: true })),
    ).pipe(
      Effect.tap((inventory) =>
        Effect.sync(() => {
          expect(inventory).toEqual({
            state: "complete",
            trackedPaths: new Set([":foo/dist/keep.txt"]),
          });
        }),
      ),
      Effect.provide(realGitLayer),
    ),
  );

  it.effect("treats a failed candidate inspection as unknown", () =>
    Effect.gen(function* () {
      const inventory = yield* readSlimTrackedPathInventory({
        worktreePath: "/worktree",
        candidatePaths: ["target"],
      });
      expect(inventory).toEqual({ state: "unknown" });
    }).pipe(
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: () => Effect.succeed(gitOutput({ exitCode: ChildProcessSpawner.ExitCode(1) })),
        }),
      ),
    ),
  );

  it.effect(
    "uses a complete candidate query when a repository-wide inventory would truncate",
    () => {
      const commands: Array<ReadonlyArray<string>> = [];
      return Effect.gen(function* () {
        const facts = yield* readWorktreeGitFacts("/worktree");
        const inventory = yield* readSlimTrackedPathInventory({
          worktreePath: "/worktree",
          candidatePaths: ["node_modules"],
        });

        expect(facts.inspection).toBe("complete");
        expect(inventory).toEqual({ state: "complete", trackedPaths: new Set() });
        expect(commands).toContainEqual([
          "--literal-pathspecs",
          "ls-files",
          "-z",
          "--",
          "node_modules",
        ]);
        expect(commands).not.toContainEqual(["ls-files", "-z"]);
      }).pipe(
        Effect.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (input) =>
              Effect.sync(() => {
                commands.push(input.args);
                if (input.args[1] === "ls-files") {
                  return gitOutput({
                    // This is what the old repository-wide call observed once it
                    // crossed the default 1 MB capture limit. The candidate call
                    // is empty and complete, so an unrelated large inventory no
                    // longer blocks ordinary cleanup.
                    stdoutTruncated: input.args.length === 2,
                  });
                }
                if (input.args[0] === "rev-list") {
                  return gitOutput({ exitCode: ChildProcessSpawner.ExitCode(1) });
                }
                if (input.args[0] === "rev-parse") return gitOutput({ stdout: "main\n" });
                return gitOutput();
              }),
          }),
        ),
      );
    },
  );

  it.effect("keeps a tracked nested target out of the slim candidate set", () =>
    Effect.gen(function* () {
      const inventory = yield* readSlimTrackedPathInventory({
        worktreePath: "/worktree",
        candidatePaths: ["crates/app/target"],
      });
      if (inventory.state !== "complete") throw new Error("Expected complete inventory");
      expect(
        decideSlimCandidate(
          { relativePath: "crates/app/target", name: "target" },
          inventory.trackedPaths,
        ),
      ).toEqual({ deletable: false, reason: "git-tracked" });
    }).pipe(
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: () => Effect.succeed(gitOutput({ stdout: "crates/app/target/main.o\0" })),
        }),
      ),
    ),
  );

  it.effect("passes filesystem names beginning with pathspec magic literally", () => {
    const commands: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const inventory = yield* readSlimTrackedPathInventory({
        worktreePath: "/worktree",
        candidatePaths: [":foo/dist"],
      });
      expect(inventory).toEqual({
        state: "complete",
        trackedPaths: new Set([":foo/dist/keep.txt"]),
      });
      expect(commands).toContainEqual(["--literal-pathspecs", "ls-files", "-z", "--", ":foo/dist"]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          execute: (input) =>
            Effect.sync(() => {
              commands.push(input.args);
              return gitOutput({ stdout: ":foo/dist/keep.txt\0" });
            }),
        }),
      ),
    );
  });
});
// @effect-diagnostics nodeBuiltinImport:off - this is a real Git regression fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
