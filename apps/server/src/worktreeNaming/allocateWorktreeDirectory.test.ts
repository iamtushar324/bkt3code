import { isWorktreeCodename, WORKTREE_CODENAMES } from "@t3tools/shared/worktreeCodename";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseWorktreeDirectoryName,
  legacyWorktreeDirectoryName,
} from "./allocateWorktreeDirectory.ts";

const LEGACY = legacyWorktreeDirectoryName("t3code/2d633e64");

function choose(seed: string, taken: readonly string[] = []) {
  return chooseWorktreeDirectoryName({
    seed,
    taken: new Set(taken),
    legacyName: LEGACY,
  });
}

describe("legacyWorktreeDirectoryName", () => {
  it("is the pre-codename shape the reactor's pure recompute still produces", () => {
    expect(legacyWorktreeDirectoryName("t3code/2d633e64")).toBe("t3code-2d633e64");
    expect(legacyWorktreeDirectoryName("feature/a/b")).toBe("feature-a-b");
  });
});

describe("chooseWorktreeDirectoryName", () => {
  it("names an empty project directory after a codename, not the branch", () => {
    const name = choose("t3code/2d633e64");
    expect(isWorktreeCodename(name)).toBe(true);
    expect(name).not.toBe(LEGACY);
  });

  it("is deterministic for a given branch", () => {
    expect(choose("t3code/2d633e64")).toBe(choose("t3code/2d633e64"));
  });

  it("gives different branches different names", () => {
    const names = new Set(
      Array.from({ length: 40 }, (_, index) => choose(`t3code/branch-${index}`)),
    );
    expect(names.size).toBeGreaterThan(30);
  });

  it("skips a name another worktree already holds", () => {
    const first = choose("t3code/2d633e64");
    const second = choose("t3code/2d633e64", [first]);

    expect(second).not.toBe(first);
    expect(isWorktreeCodename(second)).toBe(true);
  });

  it("keeps probing past a run of taken names", () => {
    const seed = "t3code/2d633e64";
    const taken: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const next = choose(seed, taken);
      expect(taken).not.toContain(next);
      taken.push(next);
    }
    expect(new Set(taken).size).toBe(25);
  });

  it("ignores directories that are not codenames", () => {
    // A project mid-migration still holds legacy hex directories. They occupy no
    // codename, so they must not consume one.
    const withLegacy = choose("t3code/2d633e64", ["t3code-aaaaaaaa", "t3code-bbbbbbbb"]);
    expect(withLegacy).toBe(choose("t3code/2d633e64"));
  });

  it("suffixes rather than failing when the whole pool is taken", () => {
    const name = chooseWorktreeDirectoryName({
      seed: "t3code/2d633e64",
      taken: new Set(WORKTREE_CODENAMES),
      legacyName: LEGACY,
    });

    expect(name).toMatch(/^[a-z][a-z0-9]{2,9}-2$/);
  });

  it("falls back to the legacy name only when even the suffixes are exhausted", () => {
    const seeded = choose("t3code/2d633e64");
    const exhausted = new Set<string>([
      ...WORKTREE_CODENAMES,
      ...Array.from({ length: 998 }, (_, index) => `${seeded}-${index + 2}`),
    ]);

    expect(
      chooseWorktreeDirectoryName({
        seed: "t3code/2d633e64",
        taken: exhausted,
        legacyName: LEGACY,
      }),
    ).toBe(LEGACY);
  });
});
