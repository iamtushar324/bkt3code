/**
 * T3-CUSTOM(expbkt3): Coverage for what a "slim" is allowed to delete.
 *
 * The tracked-path guard is the load-bearing rule here: the target list alone
 * would happily delete a `dist/` that a project actually commits.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  decideSlimCandidate,
  outermostCandidates,
  shouldDescendInto,
  SLIM_TARGET_DIRECTORY_NAMES,
} from "./slimTargets.ts";

const noTrackedFiles = new Set<string>();

const candidate = (relativePath: string) => ({
  relativePath,
  name: relativePath.split("/").findLast((segment) => segment.length > 0) ?? "",
});

describe("decideSlimCandidate", () => {
  it("deletes a top-level node_modules", () => {
    expect(decideSlimCandidate(candidate("node_modules"), noTrackedFiles)).toEqual({
      deletable: true,
      reason: "regenerable",
    });
  });

  it("deletes a nested package's node_modules", () => {
    expect(
      decideSlimCandidate(candidate("packages/contracts/node_modules"), noTrackedFiles).deletable,
    ).toBe(true);
  });

  it("leaves a directory that is not a known target", () => {
    expect(decideSlimCandidate(candidate("src"), noTrackedFiles)).toEqual({
      deletable: false,
      reason: "not-a-target",
    });
  });

  it("never touches anything under .git", () => {
    expect(decideSlimCandidate(candidate(".git/modules/x/node_modules"), noTrackedFiles)).toEqual({
      deletable: false,
      reason: "excluded-directory",
    });
  });

  it("refuses a target directory that holds tracked files", () => {
    const tracked = new Set(["vendor/dist/bundled.js"]);
    expect(decideSlimCandidate(candidate("vendor/dist"), tracked)).toEqual({
      deletable: false,
      reason: "git-tracked",
    });
  });

  it("refuses a target directory that is itself a tracked path", () => {
    const tracked = new Set(["build"]);
    expect(decideSlimCandidate(candidate("build"), tracked).reason).toBe("git-tracked");
  });

  it("is not confused by a tracked sibling with a shared prefix", () => {
    const tracked = new Set(["dist-notes/readme.md"]);
    expect(decideSlimCandidate(candidate("dist"), tracked).deletable).toBe(true);
  });

  it("rejects a path that escapes the worktree", () => {
    expect(decideSlimCandidate(candidate("../node_modules"), noTrackedFiles)).toEqual({
      deletable: false,
      reason: "escapes-worktree",
    });
    expect(decideSlimCandidate({ relativePath: "", name: "" }, noTrackedFiles).reason).toBe(
      "escapes-worktree",
    );
  });

  it("covers every advertised target name", () => {
    for (const name of SLIM_TARGET_DIRECTORY_NAMES) {
      expect(decideSlimCandidate(candidate(name), noTrackedFiles).deletable).toBe(true);
    }
  });
});

describe("shouldDescendInto", () => {
  it("stops at .git and at matched targets", () => {
    expect(shouldDescendInto(".git")).toBe(false);
    expect(shouldDescendInto("node_modules")).toBe(false);
  });

  it("descends into ordinary directories", () => {
    expect(shouldDescendInto("packages")).toBe(true);
  });
});

describe("outermostCandidates", () => {
  it("drops a match nested inside another match", () => {
    const result = outermostCandidates([
      candidate("node_modules"),
      candidate("node_modules/foo/node_modules"),
      candidate("apps/web/dist"),
    ]);
    expect(result.map((entry) => entry.relativePath)).toEqual(["node_modules", "apps/web/dist"]);
  });

  it("keeps siblings whose paths share a prefix", () => {
    const result = outermostCandidates([candidate("dist"), candidate("dist-tools")]);
    expect(result).toHaveLength(2);
  });
});
