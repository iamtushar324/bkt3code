/** T3-CUSTOM(expbkt3): regression tests for plan-review version reloads. */
import { MarkdownPlugin } from "@platejs/markdown";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { createPlateEditor, ParagraphPlugin } from "platejs/react";
import { describe, expect, it } from "vite-plus/test";

import { replacePlanReviewEditorValue } from "./planReviewEditorValue";

describe("replacePlanReviewEditorValue", () => {
  it("replaces a reviewed version without retaining the previous plan as a suggestion", () => {
    const editor = createPlateEditor({
      plugins: [ParagraphPlugin, SuggestionPlugin, MarkdownPlugin],
    });
    const original = "# Sample plan\n\nOriginal context.";
    const revised = "# Sample plan\n\nRevised context.";

    replacePlanReviewEditorValue(editor, editor.api.markdown.deserialize(original));
    editor.setOption(SuggestionPlugin, "isSuggesting", true);
    replacePlanReviewEditorValue(editor, editor.api.markdown.deserialize(revised));

    expect(editor.api.markdown.serialize().trimEnd()).toBe(revised);
  });
});
