/**
 * T3-CUSTOM(expbkt3): replaces the document shown by the plan-review editor.
 *
 * Kept outside the React component so version reloads can be exercised against
 * Plate's real transforms without mounting the full review panel.
 */
import type { Value } from "platejs";
import type { TPlateEditor } from "platejs/react";
import { SuggestionPlugin } from "@platejs/suggestion/react";

export function replacePlanReviewEditorValue(editor: TPlateEditor, value: Value): void {
  // `setValue` is a normal Slate transform. If suggestion mode is active,
  // Plate records the incoming tree as inserted and the current tree as
  // deleted; Markdown serialization then contains both complete plans. A
  // server version reload is synchronization, not a reviewer edit, so keep it
  // outside suggestion tracking and restore the reviewer's mode afterwards.
  const wasSuggesting = editor.getOption(SuggestionPlugin, "isSuggesting");
  editor.setOption(SuggestionPlugin, "isSuggesting", false);
  try {
    editor.tf.setValue(value);
  } finally {
    editor.setOption(SuggestionPlugin, "isSuggesting", wasSuggesting);
  }
}
