import { describe, expect, it } from "vite-plus/test";

import {
  countReviewCommentContexts,
  formatReviewCommentContext,
  parseReviewCommentMessageSegments,
  parseReviewInlineComments,
  type ReviewCommentTarget,
} from "./reviewCommentSelection";

function makeTarget(): ReviewCommentTarget {
  return {
    sectionId: "section-1",
    sectionTitle: "Working tree",
    filePath: "apps/demo/src/main.ts",
    startIndex: 0,
    endIndex: 1,
    lines: [
      {
        kind: "line",
        id: "line-1",
        change: "delete",
        oldLineNumber: 7,
        newLineNumber: null,
        content: "const retryLimit = 2;",
        additionTokenIndex: null,
        deletionTokenIndex: 0,
        comparison: null,
      },
      {
        kind: "line",
        id: "line-2",
        change: "add",
        oldLineNumber: null,
        newLineNumber: 7,
        content: "const retryLimit = 4;",
        additionTokenIndex: 0,
        deletionTokenIndex: null,
        comparison: null,
      },
    ],
  };
}

describe("review comment serialization", () => {
  it("keeps closing-tag text inside a chip label within a real review body", () => {
    const body = "Before [</review_comment>](t3-context://v1/mention/context-1) after";
    const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">${body}</review_comment>`;
    const segments = parseReviewCommentMessageSegments(`${serialized} tail`);
    expect(segments).toEqual([
      { kind: "review-comment", comment: expect.objectContaining({ text: body }) },
      { kind: "text", id: `review-comment-text:${serialized.length}`, text: " tail" },
    ]);
  });

  it("keeps a closing tag inside a chip label out of the inline comment body", () => {
    const body = "Before [</review_comment>](t3-context://v1/mention/context-1) after";
    const serialized = `<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">${body}</review_comment>`;

    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({ text: body }),
    ]);
  });

  it("treats legacy markup inside a context label as opaque text", () => {
    const text =
      '[<review_comment sectionId="s" filePath="app.ts" startIndex="0" endIndex="0">Review this</review_comment>](t3-context://v1/mention/context-1)';
    expect(parseReviewCommentMessageSegments(text)).toEqual([
      { kind: "text", id: "review-comment-text:0", text },
    ]);
  });
  it("preserves enough metadata for inline diff rendering", () => {
    const serialized = formatReviewCommentContext(makeTarget(), "Please keep this configurable.");

    expect(countReviewCommentContexts(serialized)).toBe(1);
    expect(parseReviewInlineComments(serialized)).toEqual([
      expect.objectContaining({
        sectionId: "section-1",
        sectionTitle: "Working tree",
        filePath: "apps/demo/src/main.ts",
        startIndex: 0,
        endIndex: 1,
        text: "Please keep this configurable.",
        diff: expect.stringContaining("-const retryLimit = 2;"),
      }),
    ]);
  });

  it("splits chat text into review comment segments", () => {
    const serialized = `Before\n${formatReviewCommentContext(makeTarget(), "Please keep this configurable.")}\nAfter`;
    const segments = parseReviewCommentMessageSegments(serialized);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual(expect.objectContaining({ kind: "text", text: "Before\n" }));
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "apps/demo/src/main.ts",
          text: "Please keep this configurable.",
          diff: expect.stringContaining("+const retryLimit = 4;"),
        }),
      }),
    );
    expect(segments[2]).toEqual(expect.objectContaining({ kind: "text", text: "\nAfter" }));
  });

  it("parses source-language review comments created by the web file viewer", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
        "Clarify this.",
        "```md",
        "# Plan",
        "- Step one",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          filePath: "docs/plan.md",
          fenceLanguage: "md",
          diff: "# Plan\n- Step one",
        }),
      }),
    );
  });

  it("keeps fenced examples in comment prose separate from the context fence", () => {
    const [segment] = parseReviewCommentMessageSegments(
      [
        '<review_comment sectionId="section-1" sectionTitle="Working tree" filePath="src/app.ts" startIndex="0" endIndex="0" rangeLabel="+1">',
        "Try this:",
        "```ts",
        "const value = 1;",
        "```",
        "Then retry.",
        "```diff",
        "@@ -0,0 +1,1 @@",
        "+one",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segment).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          text: ["Try this:", "```ts", "const value = 1;", "```", "Then retry."].join("\n"),
          diff: "@@ -0,0 +1,1 @@\n+one",
        }),
      }),
    );
  });

  it("round-trips greater-than signs in review attributes", () => {
    const serialized = formatReviewCommentContext(
      { ...makeTarget(), sectionTitle: "Changes > 5" },
      "Check this.",
    );
    const [comment] = parseReviewInlineComments(serialized);

    expect(serialized).toContain('sectionTitle="Changes &gt; 5"');
    expect(comment?.sectionTitle).toBe("Changes > 5");
  });

  // T3-CUSTOM(expbkt3): matches the web parser. A plan anchor is quoted text
  // that cannot always be located, and rejecting the block rendered raw XML.
  it("parses an anchored plan comment that carries no line range", () => {
    const segments = parseReviewCommentMessageSegments(
      [
        'Plan approved.\n\n<review_comment sectionId="plan:plan-doc:ad14" sectionTitle="Plan review" filePath="TEC-951 standup plan.md" rangeLabel="quoted text" author="Tushar Bhardwaj">',
        "no ignore this",
        "```markdown",
        "1. Outbound email context",
        "```",
        "</review_comment>",
      ].join("\n"),
    );

    expect(segments.map((segment) => segment.kind)).toEqual(["text", "review-comment"]);
    expect(segments[1]).toEqual(
      expect.objectContaining({
        kind: "review-comment",
        comment: expect.objectContaining({
          sectionId: "plan:plan-doc:ad14",
          startIndex: null,
          endIndex: null,
          rangeLabel: "quoted text",
          text: "no ignore this",
          author: "Tushar Bhardwaj",
        }),
      }),
    );
  });

  it("counts a rangeless plan comment as an inline comment", () => {
    const block = [
      '<review_comment sectionId="plan:doc" filePath="Plan.md" rangeLabel="quoted text">',
      "Reword this.",
      "```markdown",
      "## Steps",
      "```",
      "</review_comment>",
    ].join("\n");

    expect(countReviewCommentContexts(block)).toBe(1);
    expect(parseReviewInlineComments(block)).toHaveLength(1);
  });
});
