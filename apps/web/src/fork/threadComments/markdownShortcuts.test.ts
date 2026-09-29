import { describe, expect, it } from "vite-plus/test";

import { applyMarkdownShortcut, markdownShortcutForKey } from "./markdownShortcuts";

const key = (
  key: string,
  mods: Partial<{ meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }> = {},
) => ({
  key,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("markdownShortcutForKey", () => {
  it("maps Cmd/Ctrl + B, I, E, K and nothing else", () => {
    expect(markdownShortcutForKey(key("b", { meta: true }))).toBe("bold");
    expect(markdownShortcutForKey(key("I", { ctrl: true }))).toBe("italic");
    expect(markdownShortcutForKey(key("e", { ctrl: true }))).toBe("code");
    expect(markdownShortcutForKey(key("k", { meta: true }))).toBe("link");
    expect(markdownShortcutForKey(key("b"))).toBeNull();
    expect(markdownShortcutForKey(key("b", { meta: true, shift: true }))).toBeNull();
    expect(markdownShortcutForKey(key("x", { meta: true }))).toBeNull();
  });
});

describe("applyMarkdownShortcut", () => {
  it("wraps a selection and keeps it selected", () => {
    expect(
      applyMarkdownShortcut({
        value: "make it bold now",
        selectionStart: 8,
        selectionEnd: 12,
        action: "bold",
      }),
    ).toEqual({ value: "make it **bold** now", selectionStart: 10, selectionEnd: 14 });
    expect(
      applyMarkdownShortcut({
        value: "call foo()",
        selectionStart: 5,
        selectionEnd: 10,
        action: "code",
      }),
    ).toEqual({ value: "call `foo()`", selectionStart: 6, selectionEnd: 11 });
  });

  it("inserts an empty pair with the caret inside when nothing is selected", () => {
    expect(
      applyMarkdownShortcut({ value: "ab", selectionStart: 1, selectionEnd: 1, action: "italic" }),
    ).toEqual({ value: "a__b", selectionStart: 2, selectionEnd: 2 });
  });

  it("unwraps when the selection is already wrapped, inside or around", () => {
    expect(
      applyMarkdownShortcut({
        value: "x **bold** y",
        selectionStart: 2,
        selectionEnd: 10,
        action: "bold",
      }),
    ).toEqual({ value: "x bold y", selectionStart: 2, selectionEnd: 6 });
    expect(
      applyMarkdownShortcut({
        value: "x **bold** y",
        selectionStart: 4,
        selectionEnd: 8,
        action: "bold",
      }),
    ).toEqual({ value: "x bold y", selectionStart: 2, selectionEnd: 6 });
  });

  it("handles a backwards selection", () => {
    expect(
      applyMarkdownShortcut({
        value: "hello",
        selectionStart: 5,
        selectionEnd: 0,
        action: "italic",
      }),
    ).toEqual({ value: "_hello_", selectionStart: 1, selectionEnd: 6 });
  });

  it("turns a selection into a link with the url selected", () => {
    expect(
      applyMarkdownShortcut({
        value: "see docs here",
        selectionStart: 4,
        selectionEnd: 8,
        action: "link",
      }),
    ).toEqual({ value: "see [docs](url) here", selectionStart: 11, selectionEnd: 14 });
    expect(
      applyMarkdownShortcut({ value: "", selectionStart: 0, selectionEnd: 0, action: "link" }),
    ).toEqual({ value: "[text](url)", selectionStart: 1, selectionEnd: 5 });
  });
});
