/**
 * T3-CUSTOM(expbkt3): Markdown keyboard shortcuts for the comment textareas.
 *
 * Cmd/Ctrl+B, I, E and K wrap the selection in bold, italic, inline code or a
 * link, and unwrap it when it already is. The pure function is what the tests
 * cover; the DOM helper applies it through `setRangeText` so a controlled
 * React textarea keeps its caret where the user expects.
 */
export type MarkdownShortcutAction = "bold" | "italic" | "code" | "link";

const WRAPPERS: Record<Exclude<MarkdownShortcutAction, "link">, string> = {
  bold: "**",
  italic: "_",
  code: "`",
};

export interface MarkdownShortcutResult {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

export function markdownShortcutForKey(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}): MarkdownShortcutAction | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  switch (event.key.toLowerCase()) {
    case "b":
      return "bold";
    case "i":
      return "italic";
    case "e":
      return "code";
    case "k":
      return "link";
    default:
      return null;
  }
}

export function applyMarkdownShortcut(input: {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly action: MarkdownShortcutAction;
}): MarkdownShortcutResult {
  const { value, action } = input;
  const start = Math.min(input.selectionStart, input.selectionEnd);
  const end = Math.max(input.selectionStart, input.selectionEnd);
  const selected = value.slice(start, end);

  if (action === "link") {
    // `[text](url)` with the caret on the url; an empty selection leaves a
    // placeholder label selected so typing replaces it.
    if (selected.length === 0) {
      const inserted = "[text](url)";
      return {
        value: value.slice(0, start) + inserted + value.slice(end),
        selectionStart: start + 1,
        selectionEnd: start + 5,
      };
    }
    const inserted = `[${selected}](url)`;
    const urlStart = start + selected.length + 3;
    return {
      value: value.slice(0, start) + inserted + value.slice(end),
      selectionStart: urlStart,
      selectionEnd: urlStart + 3,
    };
  }

  const wrap = WRAPPERS[action];
  // Already wrapped, either inside the selection or just around it: unwrap.
  if (selected.length >= wrap.length * 2 && selected.startsWith(wrap) && selected.endsWith(wrap)) {
    const inner = selected.slice(wrap.length, selected.length - wrap.length);
    return {
      value: value.slice(0, start) + inner + value.slice(end),
      selectionStart: start,
      selectionEnd: start + inner.length,
    };
  }
  if (
    start >= wrap.length &&
    value.slice(start - wrap.length, start) === wrap &&
    value.slice(end, end + wrap.length) === wrap
  ) {
    return {
      value: value.slice(0, start - wrap.length) + selected + value.slice(end + wrap.length),
      selectionStart: start - wrap.length,
      selectionEnd: start - wrap.length + selected.length,
    };
  }
  return {
    value: value.slice(0, start) + wrap + selected + wrap + value.slice(end),
    selectionStart: start + wrap.length,
    selectionEnd: start + wrap.length + selected.length,
  };
}

/**
 * Applies the shortcut to a textarea in place and returns the new value for the
 * controlled state. `setRangeText` keeps the browser's undo stack intact.
 */
export function applyMarkdownShortcutToTextarea(
  textarea: HTMLTextAreaElement,
  action: MarkdownShortcutAction,
): string {
  const result = applyMarkdownShortcut({
    value: textarea.value,
    selectionStart: textarea.selectionStart,
    selectionEnd: textarea.selectionEnd,
    action,
  });
  textarea.setRangeText(result.value, 0, textarea.value.length, "preserve");
  textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
  return result.value;
}
