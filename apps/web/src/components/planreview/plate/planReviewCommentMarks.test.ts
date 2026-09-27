import { CommentPlugin } from "@platejs/comment/react";
import { getCommentKey, getDraftCommentKey } from "@platejs/comment";
import { MarkdownPlugin } from "@platejs/markdown";
import { BoldPlugin } from "@platejs/basic-nodes/react";
import {
  BulletedListPlugin,
  ListItemContentPlugin,
  ListItemPlugin,
  ListPlugin,
  NumberedListPlugin,
} from "@platejs/list-classic/react";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from "@platejs/table/react";
import { TextApi } from "platejs";
import { createPlateEditor } from "platejs/react";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vite-plus/test";

import {
  collectPlanReviewBlocks,
  locatePlanReviewQuoteRange,
  stripPlanReviewCommentMarks,
  type PlanReviewNodeLike,
} from "./planReviewCommentMarks";
import { hasPlanReviewEditorChange } from "@t3tools/client-runtime/state/planReviewMarkdown";

/** A plan as Plate holds it: a heading, a paragraph, and a two-item list. */
const PLAN_VALUE: ReadonlyArray<PlanReviewNodeLike> = [
  { children: [{ text: "Steps" }] },
  { children: [{ text: "File the two triage tickets that came out of standup." }] },
  {
    children: [
      {
        children: [
          {
            children: [
              { text: "Outbound email context", bold: true } as PlanReviewNodeLike,
              { text: " Ticket: new prospect threads must start." },
            ],
          },
        ],
      },
      {
        children: [{ children: [{ text: "T3 child-session context. Adjacent to TEC-920." }] }],
      },
    ],
  },
];

describe("collectPlanReviewBlocks", () => {
  it("treats the deepest text-bearing element as one line", () => {
    const blocks = collectPlanReviewBlocks(PLAN_VALUE);

    expect(blocks.map((block) => block.leaves.map((leaf) => leaf.text).join(""))).toEqual([
      "Steps",
      "File the two triage tickets that came out of standup.",
      "Outbound email context Ticket: new prospect threads must start.",
      "T3 child-session context. Adjacent to TEC-920.",
    ]);
  });

  it("keeps a leaf's path so a mark can be placed on it", () => {
    const blocks = collectPlanReviewBlocks(PLAN_VALUE);

    // The bold run and the plain run that follow it are separate leaves of the
    // same list-item content, so a mark can cover either or both.
    expect(blocks[2]!.leaves.map((leaf) => leaf.path)).toEqual([
      [2, 0, 0, 0],
      [2, 0, 0, 1],
    ]);
  });

  it("ignores an element with no children", () => {
    expect(collectPlanReviewBlocks([{ children: [] }, { text: "loose" }])).toEqual([]);
  });
});

describe("locatePlanReviewQuoteRange", () => {
  const blocks = collectPlanReviewBlocks(PLAN_VALUE);

  it("marks exactly the selected phrase inside one leaf", () => {
    expect(locatePlanReviewQuoteRange(blocks, "triage tickets")).toEqual({
      anchor: { path: [1, 0], offset: 13 },
      focus: { path: [1, 0], offset: 27 },
    });
  });

  it("resolves an anchor whose bold syntax was flattened on the way out", () => {
    // The server stored the rendered selection; the leaf is still bold text.
    const range = locatePlanReviewQuoteRange(blocks, "Outbound email context");

    expect(range).not.toBeNull();
    expect(range!.anchor).toEqual({ path: [2, 0, 0, 0], offset: 0 });
    expect(range!.focus).toEqual({ path: [2, 0, 0, 0], offset: 22 });
  });

  it("spans from the first leaf to the last across a multi-line quote", () => {
    const range = locatePlanReviewQuoteRange(
      blocks,
      "Outbound email context Ticket: new prospect threads must start.\nT3 child-session context. Adjacent to TEC-920.",
    );

    expect(range!.anchor.path).toEqual([2, 0, 0, 0]);
    expect(range!.focus.path).toEqual([2, 1, 0, 0]);
    expect(range!.focus.offset).toBe("T3 child-session context. Adjacent to TEC-920.".length);
  });

  it("returns a point in the leaf that holds the offset, not past it", () => {
    // Offset 30 of the concatenated block falls in the second leaf, 8 in.
    const range = locatePlanReviewQuoteRange(blocks, "Ticket: new prospect threads");

    expect(range!.anchor.path).toEqual([2, 0, 0, 1]);
    expect(range!.anchor.offset).toBe(1);
  });

  it("returns null for a quote that is not in the document", () => {
    expect(locatePlanReviewQuoteRange(blocks, "Revert the migration")).toBeNull();
  });

  it("returns null for an empty quote", () => {
    expect(locatePlanReviewQuoteRange(blocks, "  \n ")).toBeNull();
  });

  it("returns null when there are no blocks to search", () => {
    expect(locatePlanReviewQuoteRange([], "Steps")).toBeNull();
  });
});

/**
 * The two traps a comment highlight can fall into, checked against a real Plate
 * editor on the same plugin versions the panel uses.
 *
 * A comment mark is a leaf property applied with `split: true`, so it both mutates
 * the tree and can fragment text nodes. If either reached the serializer, adding a
 * comment would look like a reviewer edit: the panel would mark the plan dirty,
 * save a draft, and send the agent a spurious "reviewer edited the plan" document.
 */
describe("comment marks and the serialized document", () => {
  const MARKDOWN = ["## Steps", "", "1. **Outbound email context**", "2. Backfill the rows"].join(
    "\n",
  );

  function createEditor() {
    return createPlateEditor({
      plugins: [
        BoldPlugin,
        CommentPlugin,
        MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
      ],
    });
  }

  function loadedEditor() {
    const editor = createEditor();
    editor.tf.setValue(editor.api.markdown.deserialize(MARKDOWN));
    return editor;
  }

  it("leaves the serialized markdown byte-identical after a comment mark", () => {
    const editor = loadedEditor();
    const before = editor.api.markdown.serialize();

    const blocks = collectPlanReviewBlocks(
      editor.children as unknown as ReadonlyArray<PlanReviewNodeLike>,
    );
    const range = locatePlanReviewQuoteRange(blocks, "Backfill the rows");
    expect(range).not.toBeNull();

    editor.tf.setNodes(
      { comment: true, [getCommentKey("plan-discussion:1")]: true } as never,
      { at: range!, match: TextApi.isText, split: true } as never,
    );

    // The mark really did land — this is not a no-op masquerading as a pass.
    expect(editor.api.comment.has({ id: "plan-discussion:1" })).toBe(true);
    expect(editor.api.markdown.serialize()).toBe(before);
  });

  it("does not register as a reviewer edit", () => {
    const editor = loadedEditor();
    const baselineEditorMarkdown = editor.api.markdown.serialize();

    const blocks = collectPlanReviewBlocks(
      editor.children as unknown as ReadonlyArray<PlanReviewNodeLike>,
    );
    editor.tf.setNodes(
      { comment: true, [getCommentKey("plan-discussion:2")]: true } as never,
      {
        at: locatePlanReviewQuoteRange(blocks, "Outbound email context")!,
        match: TextApi.isText,
        split: true,
      } as never,
    );

    expect(
      hasPlanReviewEditorChange({
        baselineEditorMarkdown,
        editorMarkdown: editor.api.markdown.serialize(),
      }),
    ).toBe(false);
  });

  it("keeps a draft highlight out of the markdown too", () => {
    const editor = loadedEditor();
    const before = editor.api.markdown.serialize();
    const blocks = collectPlanReviewBlocks(
      editor.children as unknown as ReadonlyArray<PlanReviewNodeLike>,
    );

    editor.tf.comment.setDraft({
      at: locatePlanReviewQuoteRange(blocks, "Backfill the rows")!,
    } as never);

    // Asserted against the tree rather than `api.comment.node({isDraft})`, whose
    // default `at` is the selection — which a headless editor does not have.
    expect(JSON.stringify(editor.children)).toContain(getDraftCommentKey());
    expect(editor.api.markdown.serialize()).toBe(before);
  });

  it("restores the document when a draft highlight is cancelled", () => {
    const editor = loadedEditor();
    const before = JSON.stringify(editor.children);
    const blocks = collectPlanReviewBlocks(
      editor.children as unknown as ReadonlyArray<PlanReviewNodeLike>,
    );
    const draftKey = getDraftCommentKey();

    editor.tf.comment.setDraft({
      at: locatePlanReviewQuoteRange(blocks, "Backfill the rows")!,
    } as never);
    // The draft must actually be there, or the round trip below proves nothing.
    expect(JSON.stringify(editor.children)).toContain(draftKey);

    editor.tf.unsetNodes([draftKey], {
      at: [],
      match: (node: object) =>
        TextApi.isText(node) && (node as Record<string, unknown>)[draftKey] === true,
    } as never);

    // Only the draft key is unset; the plugin's normalizer drops the orphaned
    // `comment` mark, so no residue is left behind.
    expect(JSON.stringify(editor.children)).toBe(before);
  });
});

describe("stripPlanReviewCommentMarks", () => {
  it("removes comment properties and leaves everything else alone", () => {
    expect(
      stripPlanReviewCommentMarks([
        {
          children: [
            { text: "kept", bold: true, comment: true, comment_d1: true },
            { text: " plain", commentTransient: true },
          ],
        },
      ] as ReadonlyArray<PlanReviewNodeLike>),
    ).toEqual([{ children: [{ text: "kept", bold: true }, { text: " plain" }] }]);
  });

  it("merges leaves that split:true fragmented, so the text reads as one run", () => {
    expect(
      stripPlanReviewCommentMarks([
        {
          children: [
            { text: "Backfill " },
            { text: "the rows", comment: true, comment_d1: true },
            { text: " safely" },
          ],
        },
      ] as ReadonlyArray<PlanReviewNodeLike>),
    ).toEqual([{ children: [{ text: "Backfill the rows safely" }] }]);
  });

  it("keeps differently formatted neighbours apart", () => {
    expect(
      stripPlanReviewCommentMarks([
        {
          children: [
            { text: "bold", bold: true, comment: true, comment_d1: true },
            { text: " plain", comment: true, comment_d1: true },
          ],
        },
      ] as ReadonlyArray<PlanReviewNodeLike>),
    ).toEqual([{ children: [{ text: "bold", bold: true }, { text: " plain" }] }]);
  });
});

/**
 * The regression behind the reported full-plan resend.
 *
 * Plate serializes a commented leaf as an MDX JSX element. In a table cell
 * `mdast-util-to-markdown` throws on it outright, and the editor reads a failed
 * serialize as a reviewer edit — so merely commenting on a plan containing a
 * table made the panel send the agent the entire document back as an edit.
 */
describe("commenting a plan with a table, list and inline marks", () => {
  const RICH = [
    "## Goals & Non-Goals",
    "",
    "| Item | Notes |",
    "| ---- | ----- |",
    "| Exercise blocks | headings, tables, fences |",
    "| Stay readable | scannable in ~30 seconds |",
    "",
    "Task list:",
    "",
    "- Write the demo plan",
    "- Include a table",
    "  - Nested child item",
    "",
    "Ordinary prose with **bold**, *italic*, and `inline code`.",
  ].join("\n");

  function richEditor() {
    const editor = createPlateEditor({
      plugins: [
        BoldPlugin,
        ListPlugin,
        ListItemContentPlugin,
        ListItemPlugin,
        BulletedListPlugin,
        NumberedListPlugin,
        TablePlugin,
        TableRowPlugin,
        TableCellPlugin,
        TableCellHeaderPlugin,
        CommentPlugin,
        MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
      ],
    });
    editor.tf.setValue(editor.api.markdown.deserialize(RICH));
    return editor;
  }

  function commentEverywhere(editor: ReturnType<typeof richEditor>) {
    const blocks = collectPlanReviewBlocks(
      editor.children as unknown as ReadonlyArray<PlanReviewNodeLike>,
    );
    let marked = 0;
    for (const quote of ["Include a table", "Stay readable", "Ordinary prose with bold"]) {
      const range = locatePlanReviewQuoteRange(blocks, quote);
      if (range === null) continue;
      editor.tf.setNodes(
        { comment: true, [getCommentKey(`plan-discussion:${quote}`)]: true } as never,
        { at: range, match: TextApi.isText, split: true } as never,
      );
      marked += 1;
    }
    return marked;
  }

  it("still serializes, and byte-identically, once the marks are stripped", () => {
    const editor = richEditor();
    const before = editor.api.markdown.serialize();

    expect(commentEverywhere(editor)).toBe(3);

    expect(
      editor.api.markdown.serialize({
        value: stripPlanReviewCommentMarks(editor.children) as never,
      }),
    ).toBe(before);
  });

  it("proves the raw serializer is what breaks, so the strip is load-bearing", () => {
    const editor = richEditor();
    commentEverywhere(editor);

    // Guards against someone deleting stripPlanReviewCommentMarks because "Plate
    // seems to handle it now". If this ever stops throwing, the strip can go.
    expect(() => editor.api.markdown.serialize()).toThrow();
  });
});
