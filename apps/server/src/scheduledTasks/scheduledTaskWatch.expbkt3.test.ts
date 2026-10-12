// T3-CUSTOM(expbkt3): what fires a watch on another session.
import { describe, expect, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { watchedChange, watchNoteText, WATCH_CHANGES } from "./scheduledTaskWatch.expbkt3.ts";

const SINCE = Date.UTC(2026, 9, 11, 12, 0, 0);
const at = (minutesAfterSince: number) => DateTime.makeUnsafe(SINCE + minutesAfterSince * 60_000);
const all = { until: WATCH_CHANGES };

// Only the fields a watch reads.
const shell = (fields: Partial<Record<string, unknown>>): OrchestrationV2ThreadShell =>
  ({
    id: "mcp:11111111-2222-3333-4444-555555555555",
    title: "Child work",
    status: "running",
    activityRunStatus: null,
    activeRunId: "run-1",
    pendingRuntimeRequest: null,
    hasPendingAsyncUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    latestRunCompletedAt: null,
    archivedAt: null,
    deletedAt: null,
    ...fields,
  }) as unknown as OrchestrationV2ThreadShell;

const idle = { status: "completed", activeRunId: null };

describe("watchedChange", () => {
  it("waits while the session works", () => {
    expect(watchedChange(shell({}), all, SINCE)).toBeNull();
  });

  it("fires on a finish after the watch began, not on an older one", () => {
    expect(watchedChange(shell({ ...idle, latestRunCompletedAt: at(-5) }), all, SINCE)).toBeNull();
    expect(watchedChange(shell({ ...idle, latestRunCompletedAt: at(3) }), all, SINCE)).toEqual({
      change: "finished",
      what: "finished its turn",
    });
  });

  it("fires on an open question or approval at once", () => {
    expect(
      watchedChange(shell({ pendingRuntimeRequest: { kind: "user_input" } }), all, SINCE),
    ).toEqual({ change: "needs-human", what: "asks a blocking question" });
    // A Codex async question: the agent may still work, and it still needs a person.
    expect(watchedChange(shell({ hasPendingAsyncUserInput: true }), all, SINCE)).toEqual({
      change: "needs-human",
      what: "asks a non-blocking question",
    });
    expect(
      watchedChange(shell({ pendingRuntimeRequest: { kind: "command" } }), all, SINCE)?.what,
    ).toBe("waits for an approval");
    // An auth refresh is the provider's own sign-in.
    expect(
      watchedChange(shell({ pendingRuntimeRequest: { kind: "auth_refresh" } }), all, SINCE),
    ).toBeNull();
  });

  it("counts a plan only from a run after the watch began", () => {
    const stale = shell({ ...idle, hasActionableProposedPlan: true, latestRunCompletedAt: at(-5) });
    expect(watchedChange(stale, all, SINCE)).toBeNull();
    const fresh = shell({ ...idle, hasActionableProposedPlan: true, latestRunCompletedAt: at(2) });
    expect(watchedChange(fresh, all, SINCE)?.what).toBe("has a plan to review");
  });

  it("reports a failure only when asked for", () => {
    const failed = shell({ status: "failed", activeRunId: null, latestRunCompletedAt: at(1) });
    expect(watchedChange(failed, all, SINCE)?.change).toBe("failed");
    expect(watchedChange(failed, { until: ["finished"] }, SINCE)).toBeNull();
  });

  it("fires when the session is gone", () => {
    expect(watchedChange(null, all, SINCE)?.change).toBe("gone");
    expect(watchedChange(shell({ archivedAt: at(1) }), all, SINCE)?.what).toBe("was archived");
  });
});

describe("watchNoteText", () => {
  it("says what changed, how to read it, and that a person did not type it", () => {
    const text = watchNoteText({
      task: {
        id: ScheduledTaskId.make("scheduled-task:aaaaaaaa-1111-2222-3333-444444444444"),
        prompt: "Merge it next.",
      },
      watch: { threadId: ThreadId.make("mcp:11111111-2222-3333-4444-555555555555") },
      title: "Child work",
      change: { change: "needs-human", what: "asks a question" },
    });
    expect(text).toContain('session `11111111` "Child work" asks a question.');
    expect(text).toContain('t3_session_brief {"session":"11111111"}');
    expect(text).toContain("not typed by a person");
    expect(text.endsWith("\n\nMerge it next.")).toBe(true);
  });
});
