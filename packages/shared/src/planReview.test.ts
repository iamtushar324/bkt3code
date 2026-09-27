import { describe, expect, it } from "vite-plus/test";

import {
  buildPlanReviewApprovalPrompt,
  buildPlanReviewFeedbackPrompt,
  formatPlanReviewComment,
  locateQuotedLineRange,
  planReviewDocumentIdFromSectionId,
  planReviewFence,
} from "./planReview.ts";

const PLAN = [
  "# Auth rewrite",
  "",
  "## Steps",
  "",
  "1. Add the migration",
  "2. Backfill the rows",
  "3. Flip the flag",
].join("\n");

describe("locateQuotedLineRange", () => {
  it("finds a single quoted line", () => {
    expect(locateQuotedLineRange(PLAN, "2. Backfill the rows")).toEqual({
      startIndex: 5,
      endIndex: 5,
    });
  });

  it("finds a multi-line quote", () => {
    expect(locateQuotedLineRange(PLAN, "1. Add the migration\n2. Backfill the rows")).toEqual({
      startIndex: 4,
      endIndex: 5,
    });
  });

  it("tolerates blank lines inside the document between quoted lines", () => {
    expect(locateQuotedLineRange(PLAN, "# Auth rewrite\n## Steps")).toEqual({
      startIndex: 0,
      endIndex: 2,
    });
  });

  it("returns null when the quote is absent", () => {
    expect(locateQuotedLineRange(PLAN, "4. Delete production")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(locateQuotedLineRange(PLAN, "   \n  ")).toBeNull();
  });

  // The anchor arrives from the rendered document, where markdown syntax is
  // already gone. Each of these missed before the anchor projection landed.
  describe("anchors selected from the rendered plan", () => {
    it("matches a bold line — the reported regression", () => {
      const plan = [
        "## Steps",
        "",
        "1. **Outbound email context**",
        "   Ticket: new prospect threads must start with the full customization/copy context.",
      ].join("\n");

      expect(
        locateQuotedLineRange(
          plan,
          [
            "1. Outbound email context",
            "Ticket: new prospect threads must start with the full customization/copy context.",
          ].join("\n"),
        ),
      ).toEqual({ startIndex: 2, endIndex: 3 });
    });

    it("matches an inline-code line", () => {
      const plan = "- Run the suite for `packages/shared` only";
      expect(locateQuotedLineRange(plan, "Run the suite for packages/shared only")).toEqual({
        startIndex: 0,
        endIndex: 0,
      });
    });

    it("matches a link by its text", () => {
      const plan = "See [the customization registry](docs/operations/expbkt3.md) first";
      expect(locateQuotedLineRange(plan, "See the customization registry first")).toEqual({
        startIndex: 0,
        endIndex: 0,
      });
    });

    it("matches an image by its alt text without leaving a stray bang", () => {
      expect(locateQuotedLineRange("![the panel](shot.png) shows the rail", "the panel")).toEqual({
        startIndex: 0,
        endIndex: 0,
      });
    });

    it("matches italic, strikethrough and heading lines", () => {
      const plan = ["### _Rollout_ plan", "", "~~Ship on Friday~~"].join("\n");
      expect(locateQuotedLineRange(plan, "Rollout plan")).toEqual({
        startIndex: 0,
        endIndex: 0,
      });
      expect(locateQuotedLineRange(plan, "Ship on Friday")).toEqual({
        startIndex: 2,
        endIndex: 2,
      });
    });

    it("matches a task list item whose checkbox the renderer draws", () => {
      expect(locateQuotedLineRange("- [ ] Backfill the rows", "Backfill the rows")).toEqual({
        startIndex: 0,
        endIndex: 0,
      });
    });

    it("matches a bullet whose marker the selection dropped", () => {
      expect(
        locateQuotedLineRange("- Tear down the branch env", "Tear down the branch env"),
      ).toEqual({ startIndex: 0, endIndex: 0 });
    });

    it("still returns null for a quote that is genuinely not in the plan", () => {
      expect(locateQuotedLineRange("1. **Ship it**", "Revert it")).toBeNull();
    });
  });
});

describe("planReviewFence", () => {
  it("uses a longer fence when the content contains backticks", () => {
    const fenced = planReviewFence("markdown", "use ``` for code");
    expect(fenced.startsWith("````markdown")).toBe(true);
    expect(fenced.endsWith("````")).toBe(true);
  });
});

describe("formatPlanReviewComment", () => {
  it("emits a review_comment block the existing transcript parser understands", () => {
    const block = formatPlanReviewComment("doc-1", "Auth rewrite", {
      startIndex: 4,
      endIndex: 5,
      quotedText: "1. Add the migration\n2. Backfill the rows",
      body: "Split this into two migrations.",
      authorLabel: "Tushar",
    });

    expect(block).toContain('sectionId="plan:doc-1"');
    expect(block).toContain('filePath="Auth rewrite.md"');
    expect(block).toContain('startIndex="4"');
    expect(block).toContain('endIndex="5"');
    expect(block).toContain('rangeLabel="L5 to L6"');
    // The byline is an attribute, so the body stays the reviewer's words alone.
    expect(block).toContain('author="Tushar"');
    expect(block).not.toContain("— Tushar");
    expect(block.startsWith("<review_comment ")).toBe(true);
    expect(block.endsWith("</review_comment>")).toBe(true);
  });

  it("labels a single-line anchor without a range", () => {
    const block = formatPlanReviewComment("doc-1", "Plan", {
      startIndex: 2,
      endIndex: 2,
      quotedText: "## Steps",
      body: "Rename this heading.",
      authorLabel: null,
    });
    expect(block).toContain('rangeLabel="L3"');
    expect(block).not.toContain("author=");
  });

  it("escapes quotes in the author label", () => {
    const block = formatPlanReviewComment("doc-1", "Plan", {
      startIndex: 0,
      endIndex: 0,
      quotedText: "x",
      body: "y",
      authorLabel: 'Tushar "TB" Bhardwaj',
    });
    expect(block).toContain('author="Tushar &quot;TB&quot; Bhardwaj"');
  });

  it("omits the range when the quote could not be located", () => {
    const block = formatPlanReviewComment("doc-1", "Plan", {
      startIndex: null,
      endIndex: null,
      quotedText: "a line that moved",
      body: "Reword this.",
      authorLabel: null,
    });
    expect(block).not.toContain("startIndex=");
    expect(block).not.toContain("endIndex=");
    expect(block).toContain('rangeLabel="quoted text"');
    expect(block).toContain("a line that moved");
  });

  it("escapes quotes in the plan title", () => {
    const block = formatPlanReviewComment("doc-1", 'The "big" rewrite', {
      startIndex: 0,
      endIndex: 0,
      quotedText: "x",
      body: "y",
      authorLabel: null,
    });
    expect(block).toContain('filePath="The &quot;big&quot; rewrite.md"');
  });
});

describe("buildPlanReviewFeedbackPrompt", () => {
  const base = {
    documentId: "doc-1",
    planTitle: "Auth rewrite",
    globalComment: "",
    comments: [],
    fullDocument: null,
  };

  it("never includes the plan body", () => {
    const prompt = buildPlanReviewFeedbackPrompt({
      ...base,
      globalComment: "Too broad.",
      comments: [
        {
          startIndex: 4,
          endIndex: 4,
          quotedText: "1. Add the migration",
          body: "Split this.",
          authorLabel: null,
        },
      ],
    });

    expect(prompt).toContain("Revise the plan you proposed.");
    expect(prompt).toContain("Too broad.");
    expect(prompt).toContain("<review_comment ");
    expect(prompt).not.toContain("3. Flip the flag");
  });

  it("attaches reviewer edits as one complete source-of-truth document", () => {
    const prompt = buildPlanReviewFeedbackPrompt({
      ...base,
      fullDocument: "# Rewritten\n\nEverything changed.",
    });

    expect(prompt).toContain('mode="full"');
    expect(prompt).toContain("# Rewritten");
    expect(prompt).not.toContain("```diff");
  });

  it("omits empty sections", () => {
    const prompt = buildPlanReviewFeedbackPrompt(base);
    expect(prompt).toBe(
      "Revise the plan you proposed. Respond with the complete revised plan.\nDo not modify repository files while planning.",
    );
  });
});

describe("buildPlanReviewApprovalPrompt", () => {
  const base = {
    documentId: "doc-1",
    planTitle: "Auth rewrite",
    notes: "",
    comments: [],
    fullPlanMarkdown: null,
    fullPlanReason: null,
    wasEdited: false,
  };

  it("sends one short line when the plan is still in context", () => {
    const prompt = buildPlanReviewApprovalPrompt(base);

    expect(prompt).toBe(
      "Plan approved. Implement the plan you proposed above, exactly as written.",
    );
  });

  it("appends reviewer notes without the plan body", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      ...base,
      notes: "Start with the migration.",
    });

    expect(prompt).toContain("Reviewer notes:\nStart with the migration.");
    expect(prompt).not.toContain("PLEASE IMPLEMENT");
  });

  it("carries one complete plan when the reviewer changed it before approving", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      ...base,
      fullPlanMarkdown: PLAN.replace("Flip the flag", "Flip the flag safely"),
      wasEdited: true,
    });

    expect(prompt).toContain("Plan approved with reviewer edits.");
    expect(prompt).toContain("3. Flip the flag safely");
    expect(prompt).not.toContain("```diff");
    expect(prompt.split("# Auth rewrite")).toHaveLength(2);
  });

  it("includes anchored comments without repeating an unchanged plan", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      ...base,
      comments: [
        {
          startIndex: 5,
          endIndex: 5,
          quotedText: "2. Backfill the rows",
          body: "Keep this safe for a rolling deploy.",
          authorLabel: "Tushar",
        },
      ],
    });

    expect(prompt).toContain("<review_comment ");
    expect(prompt).toContain("Keep this safe for a rolling deploy.");
    expect(prompt).not.toContain("3. Flip the flag");
  });

  // T3-CUSTOM(expbkt3): approving with comments open is deliberate — start
  // implementing, and fold the refinements in. The old wording told the model to
  // implement "exactly as written" and then handed it a list of changes.
  describe("approving with open feedback", () => {
    const withComment = {
      ...base,
      comments: [
        {
          startIndex: 5,
          endIndex: 5,
          quotedText: "2. Backfill the rows",
          body: "Batch this.",
          authorLabel: "Tushar",
        },
      ],
    };

    it("tells the agent to implement now and apply the refinements", () => {
      const prompt = buildPlanReviewApprovalPrompt(withComment);

      expect(prompt).toContain("Plan approved — start implementing it now.");
      expect(prompt).toContain("Treat them as");
      expect(prompt).toContain("apply them as you implement");
      expect(prompt).toContain("Do not go back");
      expect(prompt).toContain("Batch this.");
    });

    it("never tells the agent to implement it exactly as written", () => {
      expect(buildPlanReviewApprovalPrompt(withComment)).not.toContain("exactly as written");
    });

    it("treats overall notes alone as refinements too", () => {
      const prompt = buildPlanReviewApprovalPrompt({ ...base, notes: "Ship behind a flag." });

      expect(prompt).toContain("Plan approved — start implementing it now.");
      expect(prompt).toContain("Reviewer notes:\nShip behind a flag.");
      expect(prompt).not.toContain("exactly as written");
    });

    it("keeps the short form when the plan is approved untouched", () => {
      const prompt = buildPlanReviewApprovalPrompt(base);

      expect(prompt).toBe(
        "Plan approved. Implement the plan you proposed above, exactly as written.",
      );
    });

    it("still applies the refinement instruction when the plan had to be repeated", () => {
      const prompt = buildPlanReviewApprovalPrompt({
        ...withComment,
        fullPlanMarkdown: PLAN,
        fullPlanReason: "this session compacted its context after the plan was written",
      });

      expect(prompt).toContain("PLEASE IMPLEMENT THIS APPROVED PLAN:");
      expect(prompt).toContain("apply them as you implement");
      expect(prompt).toContain("Batch this.");
    });
  });

  it("repeats the plan and explains why when the policy demands it", () => {
    const prompt = buildPlanReviewApprovalPrompt({
      ...base,
      fullPlanMarkdown: PLAN,
      fullPlanReason: "this session compacted its context after the plan was written",
    });

    expect(prompt).toContain("PLEASE IMPLEMENT THIS APPROVED PLAN:");
    expect(prompt).toContain("3. Flip the flag");
    expect(prompt).toContain("(The full plan is repeated because this session compacted");
  });
});

describe("planReviewDocumentIdFromSectionId", () => {
  it("recovers the document id a plan comment carries", () => {
    expect(planReviewDocumentIdFromSectionId("plan:doc-1")).toBe("doc-1");
  });

  it("returns null for file and diff comments", () => {
    expect(planReviewDocumentIdFromSectionId("src/app.ts")).toBeNull();
    expect(planReviewDocumentIdFromSectionId("")).toBeNull();
  });

  it("returns null for a plan prefix with no id", () => {
    expect(planReviewDocumentIdFromSectionId("plan:")).toBeNull();
    expect(planReviewDocumentIdFromSectionId("plan:   ")).toBeNull();
  });

  it("round-trips the section id formatPlanReviewComment writes", () => {
    const block = formatPlanReviewComment("doc-42", "Auth rewrite", {
      startIndex: 4,
      endIndex: 4,
      quotedText: "1. Add the migration",
      body: "Do this first.",
      authorLabel: null,
    });
    const sectionId = /sectionId="([^"]+)"/.exec(block)?.[1] ?? "";
    expect(planReviewDocumentIdFromSectionId(sectionId)).toBe("doc-42");
  });
});
