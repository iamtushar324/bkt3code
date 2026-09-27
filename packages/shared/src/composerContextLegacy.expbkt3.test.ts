import { describe, expect, it } from "vite-plus/test";

import { upgradeLegacyContextMessage } from "./composerContextLegacy.ts";

// T3-CUSTOM(expbkt3): a plan-review anchor is quoted text, not a line number, and
// the quote cannot always be located. Such a block used to be rejected by the
// parser, and the transcript then rendered the raw `<review_comment>` XML.
describe("upgradeLegacyContextMessage (plan review)", () => {
  const block = [
    '<review_comment sectionId="plan:plan-doc:ad144073" sectionTitle="Plan review" filePath="TEC-951 standup plan.md" rangeLabel="quoted text" author="Tushar Bhardwaj">',
    "no ignore this",
    "```markdown",
    "1. Outbound email context",
    "```",
    "</review_comment>",
  ].join("\n");

  it("keeps an anchored plan comment without a line range", () => {
    const upgraded = upgradeLegacyContextMessage(`Plan approved.\n\n${block}`);
    expect(upgraded.text).not.toContain("<review_comment");
    expect(upgraded.records).toHaveLength(1);
    expect(upgraded.records[0]).toMatchObject({
      kind: "review-comment",
      label: "TEC-951 standup plan",
      startIndex: null,
      endIndex: null,
      rangeLabel: "quoted text",
      text: "no ignore this",
      diff: "1. Outbound email context",
      fenceLanguage: "markdown",
      author: "Tushar Bhardwaj",
    });
  });

  it("still requires the identity of what was commented on", () => {
    const upgraded = upgradeLegacyContextMessage(
      '<review_comment sectionId="plan:x" rangeLabel="quoted text">orphan</review_comment>',
    );
    expect(upgraded.records).toHaveLength(0);
  });
});
