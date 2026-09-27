import { describe, expect, it } from "@effect/vitest";
import { renderThreadContextDigest } from "@t3tools/shared/sessionDigest";
import type { OrchestrationProjectShell, OrchestrationThread } from "@t3tools/contracts";

import {
  cachedThreadDigestInput,
  OFFLINE_DIGEST_PROVENANCE_NOTE,
  renderCachedThreadDigest,
} from "./offlineDigest.ts";

function message(role: string, text: string, createdAt: string) {
  return { role, text, createdAt } as OrchestrationThread["messages"][number];
}

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Ship the offline handoff",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5" },
    branch: "t3code/lleida",
    worktreePath: "/home/ubuntu/worktrees/lleida",
    createdAt: "2026-09-01T10:00:00.000Z",
    messages: [
      message("user", "Make handoff work while the host is down.", "2026-09-01T10:01:00.000Z"),
      message("assistant", "Rendering from the cache instead.", "2026-09-01T10:02:00.000Z"),
    ],
    ...overrides,
  } as OrchestrationThread;
}

const project = {
  id: "project-1",
  title: "t3code",
  workspaceRoot: "/home/ubuntu/repos/t3code",
} as OrchestrationProjectShell;

describe("renderCachedThreadDigest", () => {
  it("carries the transcript and session facts the host digest would", () => {
    const digest = renderCachedThreadDigest({ thread: thread(), project, hasMoreHistory: false });

    expect(digest.source).toBe("cache");
    expect(digest.threadId).toBe("thread-1");
    expect(digest.messageCount).toBe(2);
    expect(digest.markdown).toContain("Ship the offline handoff");
    expect(digest.markdown).toContain("t3code");
    expect(digest.markdown).toContain("Make handoff work while the host is down.");
  });

  it("declares that it came from a cache, and that git state is absent", () => {
    const digest = renderCachedThreadDigest({ thread: thread(), project, hasMoreHistory: false });

    expect(digest.markdown).toContain(OFFLINE_DIGEST_PROVENANCE_NOTE);
    expect(digest.markdown).toContain("No git information was captured for this session.");
  });

  it("says so when the cached window does not reach the start of the session", () => {
    const digest = renderCachedThreadDigest({ thread: thread(), project, hasMoreHistory: true });

    expect(digest.markdown).toContain("Older messages of this session were not available");
    expect(digest.truncated).toBe(true);
  });

  it("stays usable when the project is missing from the shell cache", () => {
    const digest = renderCachedThreadDigest({
      thread: thread(),
      project: null,
      hasMoreHistory: false,
    });

    expect(digest.markdown).toContain("unknown-project");
  });

  it("renders an empty session without inventing content", () => {
    const digest = renderCachedThreadDigest({
      thread: thread({ messages: [] as OrchestrationThread["messages"] }),
      project,
      hasMoreHistory: false,
    });

    expect(digest.markdown).toContain("This session had no messages yet.");
    expect(digest.messageCount).toBe(0);
  });
});

describe("digest parity with the host renderer", () => {
  // The whole point of sharing the renderer is that a handoff does not change
  // shape depending on who built it. Same inputs must give the same markdown.
  it("matches the host digest byte for byte given identical inputs", () => {
    const input = cachedThreadDigestInput({ thread: thread(), project, hasMoreHistory: false });
    const hostRendered = renderThreadContextDigest(input);
    const clientRendered = renderCachedThreadDigest({
      thread: thread(),
      project,
      hasMoreHistory: false,
    });

    expect(clientRendered.markdown).toBe(hostRendered.markdown);
  });
});
