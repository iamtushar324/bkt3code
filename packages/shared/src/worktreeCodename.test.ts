import { describe, expect, it } from "vite-plus/test";

import {
  disambiguateWorktreeCodenames,
  isWorktreeCodename,
  normalizeWorktreePathForCodename,
  resolveWorktreeCodename,
  worktreeCodenameFromDirectoryName,
  worktreeCodenameHash,
  worktreeCodenameToneIndex,
  WORKTREE_CITY_CODENAMES,
  WORKTREE_CODENAME_MAX_LENGTH,
  WORKTREE_CODENAME_PREFIX_DISTINCTION,
  WORKTREE_CODENAME_RESERVED_WORDS,
  WORKTREE_CODENAME_SHAPE,
  WORKTREE_CODENAME_TONE_COUNT,
  WORKTREE_CODENAMES,
  WORKTREE_DISH_CODENAMES,
} from "./worktreeCodename.ts";

describe("worktree codename pool", () => {
  it("holds enough names for the sidebar to stay unambiguous in practice", () => {
    expect(WORKTREE_CITY_CODENAMES.length).toBeGreaterThan(500);
    expect(WORKTREE_DISH_CODENAMES.length).toBeGreaterThan(100);
    expect(WORKTREE_CODENAMES.length).toBe(
      WORKTREE_CITY_CODENAMES.length + WORKTREE_DISH_CODENAMES.length,
    );
  });

  it("allocates cities before dishes", () => {
    expect(WORKTREE_CODENAMES.slice(0, WORKTREE_CITY_CODENAMES.length)).toEqual([
      ...WORKTREE_CITY_CODENAMES,
    ]);
  });

  it("keeps every name safe as a path segment, a git ref fragment, and a URL component", () => {
    const violations = WORKTREE_CODENAMES.filter((name) => !WORKTREE_CODENAME_SHAPE.test(name));
    expect(violations).toEqual([]);
  });

  it("keeps every name within the sidebar chip budget", () => {
    const tooLong = WORKTREE_CODENAMES.filter((name) => name.length > WORKTREE_CODENAME_MAX_LENGTH);
    expect(tooLong).toEqual([]);
  });

  it("has no duplicates", () => {
    const duplicates = WORKTREE_CODENAMES.filter(
      (name, index) => WORKTREE_CODENAMES.indexOf(name) !== index,
    );
    expect(duplicates).toEqual([]);
  });

  it("never lets two names share a leading prefix", () => {
    // `boston` beside `bolton` is a misreading waiting to happen. This is the
    // invariant that keeps the pool scannable rather than merely large.
    const byPrefix = new Map<string, string[]>();
    for (const name of WORKTREE_CODENAMES) {
      const prefix = name.slice(0, WORKTREE_CODENAME_PREFIX_DISTINCTION);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
    }
    const collisions = [...byPrefix.values()].filter((names) => names.length > 1);
    expect(collisions).toEqual([]);
  });

  it("excludes words that read as git or filesystem concepts", () => {
    const reserved = WORKTREE_CODENAMES.filter((name) =>
      WORKTREE_CODENAME_RESERVED_WORDS.includes(name),
    );
    expect(reserved).toEqual([]);
  });
});

describe("worktreeCodenameHash", () => {
  // Pinned so that reordering or trimming the pool cannot silently rename every
  // existing worktree — a rename is allowed, but it has to be a deliberate edit
  // to this fixture.
  it("is stable", () => {
    expect(worktreeCodenameHash("/home/ubuntu/.t3/worktrees/t3code/t3code-2d633e64")).toBe(
      4_197_367_986,
    );
    expect(worktreeCodenameHash("")).toBe(2_166_136_261);
  });

  it("ignores trailing separators and Windows separators", () => {
    const canonical = worktreeCodenameHash("/a/b/c");
    expect(worktreeCodenameHash("/a/b/c/")).toBe(canonical);
    expect(worktreeCodenameHash("  /a/b/c  ")).toBe(canonical);
    expect(worktreeCodenameHash("\\a\\b\\c")).toBe(canonical);
  });
});

describe("normalizeWorktreePathForCodename", () => {
  it("collapses the cosmetic spellings of one path", () => {
    expect(normalizeWorktreePathForCodename("C:\\work\\repo\\")).toBe("C:/work/repo");
    expect(normalizeWorktreePathForCodename(" /work/repo// ")).toBe("/work/repo");
  });
});

describe("resolveWorktreeCodename", () => {
  it("derives a pool name for a legacy hex worktree directory", () => {
    const codename = resolveWorktreeCodename(
      "/home/ubuntu/.t3/bkt3-dev/worktrees/t3code-bkmain/t3code-2d633e64",
    );
    expect(isWorktreeCodename(codename)).toBe(true);
  });

  it("is deterministic and insensitive to path spelling", () => {
    const path = "/home/ubuntu/.t3/worktrees/repo/t3code-abcd1234";
    const codename = resolveWorktreeCodename(path);
    expect(resolveWorktreeCodename(path)).toBe(codename);
    expect(resolveWorktreeCodename(`${path}/`)).toBe(codename);
    expect(resolveWorktreeCodename(path.replace(/\//g, "\\"))).toBe(codename);
  });

  it("gives different worktrees different names", () => {
    const names = new Set(
      Array.from({ length: 40 }, (_, index) =>
        resolveWorktreeCodename(`/worktrees/repo/t3code-${index}`),
      ),
    );
    // Not necessarily 40 — the pool is finite — but nowhere near degenerate.
    expect(names.size).toBeGreaterThan(30);
  });

  it("prefers a directory that already carries a codename", () => {
    // The Phase 2 seam: once directories are named, the label is read off the
    // path rather than re-derived, so the two phases agree by construction.
    expect(resolveWorktreeCodename("/worktrees/repo/lisbon")).toBe("lisbon");
    expect(resolveWorktreeCodename("/worktrees/repo/LISBON")).toBe("lisbon");
  });

  it("keeps a numeric suffix, because it identifies a distinct worktree", () => {
    expect(resolveWorktreeCodename("/worktrees/repo/lisbon-2")).toBe("lisbon-2");
    expect(resolveWorktreeCodename("/worktrees/repo/lisbon-2")).not.toBe(
      resolveWorktreeCodename("/worktrees/repo/lisbon"),
    );
  });

  it("falls back to a pool name for an empty path", () => {
    expect(isWorktreeCodename(resolveWorktreeCodename("   "))).toBe(true);
  });
});

describe("worktreeCodenameFromDirectoryName", () => {
  it("recognizes pool names and suffixed pool names only", () => {
    expect(worktreeCodenameFromDirectoryName("lisbon")).toBe("lisbon");
    expect(worktreeCodenameFromDirectoryName("lisbon-12")).toBe("lisbon-12");
    expect(worktreeCodenameFromDirectoryName("t3code-2d633e64")).toBe(null);
    expect(worktreeCodenameFromDirectoryName("not-a-city")).toBe(null);
  });
});

/** First two distinct paths in a deterministic sweep that land on the same codename. */
function findCollidingPaths(): readonly [string, string] {
  const seen = new Map<string, string>();
  for (let index = 0; index < 20_000; index += 1) {
    const path = `/worktrees/repo/t3code-${index}`;
    const codename = resolveWorktreeCodename(path);
    const previous = seen.get(codename);
    if (previous !== undefined) {
      return [previous, path];
    }
    seen.set(codename, path);
  }
  throw new Error("no codename collision found in the sweep");
}

describe("disambiguateWorktreeCodenames", () => {
  it("leaves distinct worktrees unsuffixed", () => {
    const paths = ["/worktrees/repo/lisbon", "/worktrees/repo/osaka"];
    const labels = disambiguateWorktreeCodenames(paths);
    expect(labels.get("/worktrees/repo/lisbon")).toBe("lisbon");
    expect(labels.get("/worktrees/repo/osaka")).toBe("osaka");
  });

  it("is keyed by the caller's own string", () => {
    const labels = disambiguateWorktreeCodenames(["/worktrees/repo/lisbon/"]);
    expect(labels.get("/worktrees/repo/lisbon/")).toBe("lisbon");
  });

  it("gives one label to two threads sharing a worktree", () => {
    const shared = "/worktrees/repo/lisbon";
    const labels = disambiguateWorktreeCodenames([shared, shared, "/worktrees/repo/osaka"]);
    expect(labels.get(shared)).toBe("lisbon");
    expect(labels.size).toBe(2);
  });

  it("suffixes only the names that actually collide in the rendered set", () => {
    const [left, right] = findCollidingPaths();
    const shared = resolveWorktreeCodename(left);
    const labels = disambiguateWorktreeCodenames([left, right, "/worktrees/repo/osaka"]);

    expect(labels.get(left)).not.toBe(labels.get(right));
    expect(labels.get(left)).toMatch(new RegExp(`^${shared}·[0-9a-f]{2}$`));
    expect(labels.get(right)).toMatch(new RegExp(`^${shared}·[0-9a-f]{2}$`));
    // The uninvolved worktree is untouched.
    expect(labels.get("/worktrees/repo/osaka")).toBe("osaka");
  });

  it("does not suffix a colliding name when only one of the pair is on screen", () => {
    const [left] = findCollidingPaths();
    expect(disambiguateWorktreeCodenames([left]).get(left)).toBe(resolveWorktreeCodename(left));
  });

  it("skips blank paths", () => {
    expect(disambiguateWorktreeCodenames(["", "   "]).size).toBe(0);
  });
});

describe("worktreeCodenameToneIndex", () => {
  it("stays inside the static Tailwind class table", () => {
    for (const name of WORKTREE_CODENAMES) {
      const tone = worktreeCodenameToneIndex(name);
      expect(Number.isInteger(tone)).toBe(true);
      expect(tone).toBeGreaterThanOrEqual(0);
      expect(tone).toBeLessThan(WORKTREE_CODENAME_TONE_COUNT);
    }
  });

  it("spreads names across every bucket", () => {
    const used = new Set(WORKTREE_CODENAMES.map(worktreeCodenameToneIndex));
    expect(used.size).toBe(WORKTREE_CODENAME_TONE_COUNT);
  });
});
