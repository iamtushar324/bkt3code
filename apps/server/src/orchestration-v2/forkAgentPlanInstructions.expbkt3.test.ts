import { describe, expect, it } from "vite-plus/test";

import { appendAgentPlanInstructions } from "./forkAgentPlanInstructions.expbkt3.ts";

describe("server agent plan instructions", () => {
  it("keeps the complete provider message unchanged when submission is enabled", () => {
    const text = "Create a plan.\n\n<thread_comments>Keep the fork features.</thread_comments>";
    expect(appendAgentPlanInstructions(text, true)).toBe(text);
  });

  it("preserves the prompt and comments and requests a complete chat plan when disabled", () => {
    const text = "Create a plan.\n\n<thread_comments>Keep the fork features.</thread_comments>";
    const result = appendAgentPlanInstructions(text, false);
    expect(result.startsWith(`${text}\n\n`)).toBe(true);
    expect(result).toContain("Write the complete plan directly in your main chat response.");
    expect(result).toContain("Do not call t3_submit_plan");
  });

  it.each(["/compact", "  /review current changes", "/model"])(
    "keeps the native provider command %s unchanged",
    (text) => {
      expect(appendAgentPlanInstructions(text, false)).toBe(text);
    },
  );
});
