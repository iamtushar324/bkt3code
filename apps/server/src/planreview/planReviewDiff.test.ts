import { describe, expect, it } from "vite-plus/test";

import { buildUnifiedDiff, toRenderableFileDiff } from "./planReviewDiff.ts";

describe("buildUnifiedDiff", () => {
  it("returns an empty diff for identical documents", () => {
    const result = buildUnifiedDiff("# Plan\n\nStep one.\n", "# Plan\n\nStep one.\n");
    expect(result.diff).toBe("");
    expect(result.stats).toEqual({ added: 0, removed: 0, changeRatio: 0 });
  });

  it("ignores a trailing-newline-only difference", () => {
    expect(buildUnifiedDiff("a\nb\n", "a\nb").diff).toBe("");
  });

  it("emits a hunk with surrounding context for a single changed line", () => {
    const before = ["one", "two", "three", "four", "five"].join("\n");
    const after = ["one", "two", "THREE", "four", "five"].join("\n");
    const result = buildUnifiedDiff(before, after);

    expect(result.diff).toBe(
      ["@@ -1,5 +1,5 @@", " one", " two", "-three", "+THREE", " four", " five"].join("\n"),
    );
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(1);
  });

  it("counts pure additions without removals", () => {
    const result = buildUnifiedDiff("one\ntwo", "one\ntwo\nthree");
    expect(result.stats.added).toBe(1);
    expect(result.stats.removed).toBe(0);
    expect(result.diff).toContain("+three");
  });

  it("splits distant changes into separate hunks", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 2", "CHANGED 2").replace("line 35", "CHANGED 35");
    const result = buildUnifiedDiff(before, after);

    expect(result.diff.match(/^@@ /gm)).toHaveLength(2);
  });

  it("counts a modified line once, not as an add plus a remove", () => {
    const before = ["a", "b", "c", "d"].join("\n");
    const after = ["a", "B", "C", "D"].join("\n");
    // 3 of 4 lines changed — not 6 of 4.
    expect(buildUnifiedDiff(before, after).stats.changeRatio).toBeCloseTo(0.75);

    const light = buildUnifiedDiff(
      Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
      Array.from({ length: 20 }, (_, index) => (index === 5 ? "changed" : `line ${index}`)).join(
        "\n",
      ),
    );
    expect(light.stats.changeRatio).toBeCloseTo(0.05);
  });

  it("keeps a half-rewritten document under the full-document threshold", () => {
    const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const after = Array.from({ length: 40 }, (_, index) =>
      index < 15 ? `rewritten ${index}` : `line ${index}`,
    ).join("\n");
    // 15 of 40 lines reworded is a diff worth sending, not a rewrite.
    expect(buildUnifiedDiff(before, after).stats.changeRatio).toBeCloseTo(0.375);
  });

  it("handles an empty document on either side", () => {
    expect(buildUnifiedDiff("", "new line").stats.added).toBe(1);
    expect(buildUnifiedDiff("old line", "").stats.removed).toBe(1);
  });

  it("normalizes CRLF so a line-ending change is not a diff", () => {
    expect(buildUnifiedDiff("a\r\nb", "a\nb").diff).toBe("");
  });
});

describe("toRenderableFileDiff", () => {
  it("wraps a diff in git headers the diff viewer understands", () => {
    const wrapped = toRenderableFileDiff("Auth rewrite.md", "@@ -1,1 +1,1 @@\n-a\n+b");
    expect(wrapped.split("\n").slice(0, 3)).toEqual([
      "diff --git a/Auth rewrite.md b/Auth rewrite.md",
      "--- a/Auth rewrite.md",
      "+++ b/Auth rewrite.md",
    ]);
  });

  it("returns an empty string when there is nothing to render", () => {
    expect(toRenderableFileDiff("Plan.md", "")).toBe("");
  });
});
