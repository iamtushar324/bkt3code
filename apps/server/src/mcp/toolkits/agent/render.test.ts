import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { PendingQuestion } from "./pending.ts";
import { QUESTION_KIND_TEXT, renderQuestion, sessionActivity } from "./render.ts";
import type { SessionShell } from "./view.ts";

const NOW = Date.UTC(2026, 9, 12, 7, 0, 0);
const at = (minutesAgo: number) => DateTime.makeUnsafe(NOW - minutesAgo * 60_000);
const ASYNC_ID = "runtime-request:codex:native-request:async:9e9c4c3e-50f1-4f9e-a521-b41c3a04c7af";
const OPTION = "Prime-service starts dbt four times daily (recommended).";

const question = (fields: Partial<PendingQuestion>): PendingQuestion => ({
  requestId: ASYNC_ID,
  questions: [
    {
      id: "0",
      header: "Question",
      question: "Which DAILY refresh trigger must I implement?",
      // Codex sends no description; T3 copies the label into it.
      options: [{ label: OPTION, description: OPTION }],
    },
  ],
  textOnly: true,
  async: true,
  askedAt: null,
  ...fields,
});

// Only the fields the state reads.
const shell = (fields: Partial<Record<string, unknown>>): SessionShell =>
  ({
    id: "86157111-97e0-449f-9a7e-f65b82072544",
    status: "running",
    activityRunStatus: null,
    activeRunId: "run-1",
    activityRunStartedAt: at(3),
    pendingRuntimeRequest: null,
    hasPendingAsyncUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    updatedAt: at(1),
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    ...fields,
  }) as unknown as SessionShell;

describe("renderQuestion", () => {
  it("says a non-blocking question did not stop the agent, and how to answer or dismiss it", () => {
    const lines = renderQuestion(question({}), "86157111");
    expect(lines[0]?.trim()).toBe(QUESTION_KIND_TEXT.nonBlocking);
    // The label once, not again as its own description.
    expect(lines).toContain(`     1. ${OPTION}`);
    expect(lines.at(-1)).toBe(
      '   → `t3_answer {"session":"86157111","requestId":"9e9c4c3e","choice":1}` · or `t3_answer {"session":"86157111","requestId":"9e9c4c3e","dismiss":true}`',
    );
  });

  it("says a blocking question pauses the agent, and needs no request id", () => {
    const lines = renderQuestion(question({ async: false, textOnly: false }), "86157111");
    expect(lines[0]?.trim()).toBe(QUESTION_KIND_TEXT.blocking);
    expect(lines.at(-1)).toBe('   → `t3_answer {"session":"86157111","choice":1}`');
  });
});

describe("sessionActivity", () => {
  it("does not call a working agent with a non-blocking question paused", () => {
    expect(sessionActivity(shell({ hasPendingAsyncUserInput: true }), NOW)).toBe(
      "running for 3m · asked a non-blocking question",
    );
    expect(
      sessionActivity(
        shell({ hasPendingAsyncUserInput: true, status: "completed", activeRunId: null }),
        NOW,
      ),
    ).toBe("idle · asked a non-blocking question");
  });

  it("still says a blocking question waits on a person", () => {
    expect(
      sessionActivity(
        shell({ pendingRuntimeRequest: { kind: "user_input", createdAt: at(10) } }),
        NOW,
      ),
    ).toBe("waits on a person for 10m");
  });
});
