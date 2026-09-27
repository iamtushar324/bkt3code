import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { slimWorktree } from "./worktreeScan.ts";

const testLayer = Layer.mergeAll(NodeServices.layer, Layer.mock(GitVcsDriver.GitVcsDriver)({}));

const candidate = { relativePath: "node_modules", name: "node_modules" };

const makeWorktree = Effect.fn("SessionArchive.test.makeWorktree")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "session-archive-slim-" });
  const target = path.join(root, candidate.relativePath);
  yield* fs.makeDirectory(target, { recursive: true });
  yield* fs.writeFileString(path.join(target, "generated.js"), "generated");
  return { root, target };
});

describe("slimWorktree", () => {
  it.effect("does not delete when the immediate Git inventory recheck is unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, target } = yield* makeWorktree();

      const freed = yield* slimWorktree({
        worktreePath: root,
        candidates: [candidate],
        trackedPaths: new Set(),
        // This is the service's fail-closed result for a failed/truncated
        // candidate `git ls-files` query.
        canDeleteCandidate: () => Effect.succeed(false),
      });

      expect(freed).toBe(0);
      expect(yield* fs.exists(target)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes an ordinary regenerable directory after a complete recheck", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, target } = yield* makeWorktree();

      const freed = yield* slimWorktree({
        worktreePath: root,
        candidates: [candidate],
        trackedPaths: new Set(),
        canDeleteCandidate: () => Effect.succeed(true),
      });

      expect(freed).toBeGreaterThan(0);
      expect(yield* fs.exists(target)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps a candidate when Git changes while it is being measured", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, target } = yield* makeWorktree();
      let recheckedAfterMeasurement = false;

      const freed = yield* slimWorktree({
        worktreePath: root,
        candidates: [candidate],
        trackedPaths: new Set(),
        canDeleteCandidate: (_candidate, measuredBytes) =>
          Effect.gen(function* () {
            // A newly tracked file arrives while the 200k-entry sizing walk
            // runs. This final guard receives the completed measurement, so
            // moving it above measureDirectory would fail this regression.
            expect(measuredBytes).toBeGreaterThan(0);
            expect(yield* fs.exists(path.join(target, "generated.js")).pipe(Effect.orDie)).toBe(
              true,
            );
            recheckedAfterMeasurement = true;
            return false;
          }),
      });

      expect(recheckedAfterMeasurement).toBe(true);
      expect(freed).toBe(0);
      expect(yield* fs.exists(target)).toBe(true);
    }).pipe(Effect.provide(testLayer)),
  );
});
