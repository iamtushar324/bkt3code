import { describe, expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { buildAnswers, type QuestionView } from "./answers.ts";

const branch: QuestionView = {
  id: "branch",
  header: "Branch",
  question: "Which branch should I use?",
  options: [
    { label: "main", description: "The default branch" },
    { label: "stage", description: "The stage branch", value: "stage-branch" },
  ],
};

const checks: QuestionView = {
  id: "checks",
  header: "Checks",
  question: "Which checks should run?",
  multiSelect: true,
  options: [
    { label: "lint", description: "Lint" },
    { label: "tests", description: "Tests" },
  ],
};

const succeed = (result: Result.Result<unknown, string>) => {
  if (Result.isFailure(result)) throw new Error(result.failure);
  return result.success;
};

describe("buildAnswers", () => {
  it("takes an option by number or label and sends its value", () => {
    expect(succeed(buildAnswers([branch], { choice: 2 }, false))).toEqual({
      branch: "stage-branch",
    });
    expect(succeed(buildAnswers([branch], { choice: "MAIN" }, false))).toEqual({ branch: "main" });
    expect(succeed(buildAnswers([branch], { choice: "1" }, false))).toEqual({ branch: "main" });
  });

  it("sends several choices as a list, or as one line when the request takes only text", () => {
    expect(succeed(buildAnswers([checks], { choice: [1, "tests"] }, false))).toEqual({
      checks: ["lint", "tests"],
    });
    expect(succeed(buildAnswers([checks], { choice: [1, 2] }, true))).toEqual({
      checks: "lint, tests",
    });
  });

  it("accepts a custom answer unless the question forbids one", () => {
    expect(succeed(buildAnswers([branch], { text: " release " }, false))).toEqual({
      branch: "release",
    });
    const strict = buildAnswers([{ ...branch, allowCustomAnswer: false }], { text: "x" }, false);
    expect(Result.isFailure(strict)).toBe(true);
  });

  it("refuses an unknown option and names the real ones", () => {
    const unknown = buildAnswers([branch], { choice: "dev" }, false);
    expect(Result.isFailure(unknown) && unknown.failure).toContain("1. main; 2. stage");
    const outOfRange = buildAnswers([branch], { choice: 3 }, false);
    expect(Result.isFailure(outOfRange)).toBe(true);
  });

  it("needs one entry per question when a request asks several", () => {
    const single = buildAnswers([branch, checks], { choice: 1 }, false);
    expect(Result.isFailure(single) && single.failure).toContain("Pass answers");
    expect(
      succeed(
        buildAnswers(
          [branch, checks],
          {
            answers: [
              { question: 1, choice: 1 },
              { question: "checks", choice: [2] },
            ],
          },
          false,
        ),
      ),
    ).toEqual({ branch: "main", checks: ["tests"] });
    const missing = buildAnswers(
      [branch, checks],
      { answers: [{ question: 1, choice: 1 }] },
      false,
    );
    expect(Result.isFailure(missing) && missing.failure).toContain('"Checks"');
  });
});
