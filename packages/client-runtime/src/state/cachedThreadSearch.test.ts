import { describe, expect, it } from "@effect/vitest";
import type { OrchestrationThread } from "@t3tools/contracts";

import { cachedSearchSnippet, searchCachedThreads } from "./cachedThreadSearch.ts";

function thread(
  id: string,
  messages: ReadonlyArray<{ role: string; text: string; createdAt: string }>,
): OrchestrationThread {
  return { id, projectId: "project-1", messages } as unknown as OrchestrationThread;
}

const alpha = thread("thread-alpha", [
  { role: "user", text: "Investigate the eviction sweep", createdAt: "2026-09-01T10:00:00.000Z" },
  { role: "assistant", text: "The sweep runs at startup", createdAt: "2026-09-01T10:01:00.000Z" },
]);
const beta = thread("thread-beta", [
  { role: "user", text: "Unrelated work", createdAt: "2026-09-01T09:00:00.000Z" },
]);

describe("searchCachedThreads", () => {
  it("finds the work the operator was just in", () => {
    const matches = searchCachedThreads([alpha, beta], "sweep");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.threadId).toBe("thread-alpha");
    expect(matches[0]?.source).toBe("assistant");
    expect(matches[0]?.snippet).toContain("sweep");
  });

  it("reports one match per thread, from its newest hit", () => {
    const matches = searchCachedThreads([alpha], "the");

    expect(matches).toHaveLength(1);
    expect(matches[0]?.messageCreatedAt).toBe("2026-09-01T10:01:00.000Z");
  });

  it("orders newest first and honours the cap", () => {
    const older = thread("thread-older", [
      { role: "user", text: "sweep it", createdAt: "2026-08-01T10:00:00.000Z" },
    ]);
    const matches = searchCachedThreads([older, alpha], "sweep");

    expect(matches.map((match) => match.threadId)).toEqual(["thread-alpha", "thread-older"]);
    expect(searchCachedThreads([older, alpha], "sweep", 1)).toHaveLength(1);
  });

  it("is case-insensitive and ignores an empty query", () => {
    expect(searchCachedThreads([alpha], "EVICTION")).toHaveLength(1);
    expect(searchCachedThreads([alpha], "   ")).toHaveLength(0);
  });

  it("ignores roles the host search does not return either", () => {
    const system = thread("thread-system", [
      { role: "system", text: "sweep", createdAt: "2026-09-01T10:00:00.000Z" },
    ]);
    expect(searchCachedThreads([system], "sweep")).toHaveLength(0);
  });
});

describe("cachedSearchSnippet", () => {
  it("centres the snippet on the hit and marks a trimmed lead", () => {
    const text = `${"x".repeat(200)} needle ${"y".repeat(200)}`;
    const snippet = cachedSearchSnippet(text, "needle");

    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThanOrEqual(240);
  });

  it("falls back to the head when the needle is absent", () => {
    expect(cachedSearchSnippet("short text", "missing")).toBe("short text");
  });
});
