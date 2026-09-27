import { describe, expect, it } from "vite-plus/test";

import {
  countPlanOutlineComments,
  hasPlanReviewEditorChange,
  parsePlanOutline,
  resolveSubmittedPlanMarkdown,
} from "./planReviewMarkdown.ts";

const CANONICAL_PLAN = [
  "## Context",
  "",
  "Attaching a second instance is broken today, and it fails closed.",
  "",
  "- Transport is fine — pairing exchange `200`, WebSocket opens, and the descriptor",
  "  advertises every fork capability.",
  "- The session carries **no user at all**.",
  "",
  "The handler uses `resolveIdentity` (line ~494).",
].join("\n");

const PLATE_NORMALIZED_PLAN = [
  "## Context",
  "",
  "Attaching a second instance is broken today, and it fails closed.\\",
  "",
  "* Transport is fine — pairing exchange `200`, WebSocket opens, and the descriptoradvertises every fork capability.",
  "* The session carries **no user at all**.",
  "",
  "The handler uses `resolveIdentity` (line \\~494).",
].join("\n");

describe("resolveSubmittedPlanMarkdown", () => {
  it("preserves the canonical plan when the reviewer did not edit it", () => {
    expect(
      resolveSubmittedPlanMarkdown({
        canonicalMarkdown: CANONICAL_PLAN,
        editorMarkdown: PLATE_NORMALIZED_PLAN,
        hasReviewerEdits: false,
      }),
    ).toBe(CANONICAL_PLAN);
  });

  it("uses the editor markdown after a real reviewer edit", () => {
    expect(
      resolveSubmittedPlanMarkdown({
        canonicalMarkdown: CANONICAL_PLAN,
        editorMarkdown: `${PLATE_NORMALIZED_PLAN}\n\nReviewer addition.`,
        hasReviewerEdits: true,
      }),
    ).toBe(`${PLATE_NORMALIZED_PLAN}\n\nReviewer addition.`);
  });
});

const OUTLINED_PLAN = [
  "# TEC-951 standup plan", // 0
  "", // 1
  "## Goal", // 2
  "", // 3
  "File the two triage tickets.", // 4
  "", // 5
  "## Steps", // 6
  "", // 7
  "1. **Outbound email context**", // 8
  "2. `T3` child-session context", // 9
  "", // 10
  "```bash", // 11
  "# not a heading", // 12
  "```", // 13
  "", // 14
  "### Verification", // 15
  "", // 16
  "Run the scoped suite.", // 17
].join("\n");

describe("parsePlanOutline", () => {
  it("reads every heading with its depth and line", () => {
    expect(parsePlanOutline(OUTLINED_PLAN)).toEqual([
      { lineIndex: 0, depth: 1, text: "TEC-951 standup plan" },
      { lineIndex: 2, depth: 2, text: "Goal" },
      { lineIndex: 6, depth: 2, text: "Steps" },
      { lineIndex: 15, depth: 3, text: "Verification" },
    ]);
  });

  it("ignores a comment inside a fenced block", () => {
    expect(parsePlanOutline(OUTLINED_PLAN).map((heading) => heading.text)).not.toContain(
      "not a heading",
    );
  });

  it("strips inline formatting from a heading", () => {
    expect(parsePlanOutline("## The **big** `rewrite`")).toEqual([
      { lineIndex: 0, depth: 2, text: "The big rewrite" },
    ]);
  });

  it("ignores a closing-hash-only heading and a bare hash", () => {
    expect(parsePlanOutline(["#", "#hashtag", "## Real ##"].join("\n"))).toEqual([
      { lineIndex: 2, depth: 2, text: "Real" },
    ]);
  });

  it("returns nothing for a plan with no headings", () => {
    expect(parsePlanOutline("Just prose.\n\nMore prose.")).toEqual([]);
  });
});

describe("countPlanOutlineComments", () => {
  const headings = parsePlanOutline(OUTLINED_PLAN);

  it("assigns each comment to the heading above it", () => {
    // Lines 8 and 9 are under "Steps" (6); line 17 is under "Verification" (15).
    expect(countPlanOutlineComments(headings, [8, 9, 17])).toEqual(
      new Map([
        [6, 2],
        [15, 1],
      ]),
    );
  });

  it("counts a comment on the heading line itself against that heading", () => {
    expect(countPlanOutlineComments(headings, [6])).toEqual(new Map([[6, 1]]));
  });

  it("skips a comment whose anchor could not be located", () => {
    expect(countPlanOutlineComments(headings, [null, null])).toEqual(new Map());
  });

  it("skips a comment that sits above the first heading", () => {
    expect(countPlanOutlineComments(parsePlanOutline("intro\n\n## Later"), [0])).toEqual(new Map());
  });
});

describe("hasPlanReviewEditorChange", () => {
  it("ignores Plate's load-time change notification", () => {
    expect(
      hasPlanReviewEditorChange({
        baselineEditorMarkdown: PLATE_NORMALIZED_PLAN,
        editorMarkdown: PLATE_NORMALIZED_PLAN,
      }),
    ).toBe(false);
  });

  it("recognizes the first real reviewer edit", () => {
    expect(
      hasPlanReviewEditorChange({
        baselineEditorMarkdown: PLATE_NORMALIZED_PLAN,
        editorMarkdown: `${PLATE_NORMALIZED_PLAN}\n\nReviewer addition.`,
      }),
    ).toBe(true);
  });
});
