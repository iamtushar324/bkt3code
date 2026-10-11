import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationThread } from "@t3tools/contracts";

import { boundSessionDetail, SESSION_DETAIL_MAX_CHARS } from "./sessionDetail.ts";

const at = (minute: number) => `2026-10-11T09:${String(minute).padStart(2, "0")}:00.000Z`;

const message = (index: number, text: string) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text,
  turnId: null,
  streaming: false,
  sentByUserId: null,
  createdAt: at(index),
  updatedAt: at(index),
});

const activity = (index: number, payload: unknown) => ({
  id: `event-${index}`,
  tone: "tool",
  kind: "tool.completed",
  summary: `Tool ${index}`,
  payload,
  turnId: null,
  createdAt: at(index),
});

const plan = (index: number, markdown: string) => ({
  id: `plan-${index}`,
  turnId: null,
  planMarkdown: markdown,
  implementedAt: null,
  implementationThreadId: null,
  createdAt: at(index),
  updatedAt: at(index),
});

// Only the collections the bound reads; the rest of the shell passes through.
const thread = (fields: Partial<Record<string, unknown>>) =>
  ({
    id: "thread-1",
    title: "Session",
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    pullRequests: [],
    ...fields,
  }) as unknown as OrchestrationThread;

describe("boundSessionDetail", () => {
  it("keeps a small session whole and says nothing was cut", () => {
    const bounded = boundSessionDetail(
      thread({ messages: [message(0, "hello"), message(1, "hi")] }),
      { messageLimit: 30, activityLimit: 50 },
    );
    expect(bounded.thread.messages.map((entry) => entry.text)).toEqual(["hello", "hi"]);
    expect(bounded.omitted).toEqual([]);
  });

  it("caps long texts, older plans and big payloads, and names each cut", () => {
    const bounded = boundSessionDetail(
      thread({
        messages: [message(0, "x".repeat(20_000))],
        activities: [activity(1, { output: "y".repeat(5_000) }), activity(2, { ok: true })],
        proposedPlans: [
          plan(1, "# Old plan\n\nbody"),
          plan(2, `# New plan\n\n${"z".repeat(9_000)}`),
        ],
      }),
      { messageLimit: 30, activityLimit: 50 },
    );
    expect(bounded.thread.messages[0]?.text.length).toBeLessThan(6_100);
    expect(bounded.thread.activities[0]?.payload).toBe("[payload omitted: 5013 characters]");
    expect(bounded.thread.activities[1]?.payload).toEqual({ ok: true });
    expect(bounded.thread.proposedPlans[0]).toMatchObject({ id: "plan-1", headline: "Old plan" });
    expect(bounded.thread.proposedPlans[0]).not.toHaveProperty("planMarkdown");
    expect(bounded.thread.proposedPlans[1]?.id).toBe("plan-2");
    expect(bounded.omitted).toHaveLength(4);
  });

  it("sheds the oldest records until the detail fits", () => {
    const messages = Array.from({ length: 40 }, (_, index) => message(index, "m".repeat(5_000)));
    const bounded = boundSessionDetail(thread({ messages }), {
      messageLimit: 200,
      activityLimit: 50,
    });
    expect(JSON.stringify(bounded.thread).length).toBeLessThanOrEqual(SESSION_DETAIL_MAX_CHARS);
    expect(bounded.thread.messages.at(-1)?.id).toBe("message-39");
    expect(bounded.omitted.some((note) => note.includes("older message(s)"))).toBe(true);
  });

  it("returns no messages for a limit of zero", () => {
    const bounded = boundSessionDetail(thread({ messages: [message(0, "hello")] }), {
      messageLimit: 0,
      activityLimit: 0,
    });
    expect(bounded.thread.messages).toEqual([]);
  });
});
