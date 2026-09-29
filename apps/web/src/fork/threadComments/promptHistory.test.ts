import { describe, expect, it } from "vite-plus/test";

import { recallableComposerPrompt } from "../../components/chat/composerPromptHistory";
import { THREAD_COMMENTS_EMPTY_SEND_TEXT } from "./model";

describe("comments-only sends and prompt history", () => {
  it("is not recalled with ArrowUp, like the attachment bootstrap prompt", () => {
    expect(recallableComposerPrompt(THREAD_COMMENTS_EMPTY_SEND_TEXT)).toBe("");
    expect(recallableComposerPrompt(`  ${THREAD_COMMENTS_EMPTY_SEND_TEXT}\n`)).toBe("");
  });

  it("still recalls what the user typed around comments", () => {
    expect(recallableComposerPrompt("also rename the column")).toBe("also rename the column");
  });
});
