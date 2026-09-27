/**
 * T3-CUSTOM(expbkt3): Coverage for the session manifest record.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  renderSessionManifest,
  summarizeMessageSenders,
  type SessionManifestInput,
} from "./manifest.ts";

function input(overrides: Partial<SessionManifestInput> = {}): SessionManifestInput {
  return {
    threadId: "11111111-2222-3333-4444-555555555555",
    title: "Fix the cache key",
    projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    projectName: "hermes",
    workspaceRoot: "/home/u/repos/hermes",
    worktreePath: "/home/u/.t3/dev/worktrees/hermes/task-1",
    branch: "t3code/fix-cache-key",
    providerInstanceId: "claudeAgent",
    model: "claude-fable-5",
    ownerUserId: "user-1",
    createdAt: "2026-08-01T10:00:00.000Z",
    archivedAt: "2026-08-02T10:00:00.000Z",
    deletedAt: null,
    exportedAt: "2026-08-02T10:00:01.000Z",
    linearIssueUrl: "https://linear.app/x/issue/TEC-1",
    parentThreadId: null,
    messageCount: 4,
    activityCount: 9,
    messageSenders: [],
    git: null,
    reclaimNote: null,
    files: [{ name: "a.md", bytes: 100 }],
    rawTranscripts: [],
    ...overrides,
  };
}

describe("renderSessionManifest", () => {
  it("round-trips through JSON.parse with the load-bearing fields", () => {
    const parsed = JSON.parse(renderSessionManifest(input())) as Record<string, unknown>;
    expect(parsed["schemaVersion"]).toBe(1);
    expect(parsed["threadId"]).toBe("11111111-2222-3333-4444-555555555555");
    expect(parsed["project"]).toEqual({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      name: "hermes",
      workspaceRoot: "/home/u/repos/hermes",
    });
    expect(parsed["deleted"]).toBe(false);
    expect(parsed["ownerUserId"]).toBe("user-1");
    expect(parsed["files"]).toEqual([{ name: "a.md", bytes: 100 }]);
  });

  it("flags a soft-deleted session", () => {
    const parsed = JSON.parse(
      renderSessionManifest(input({ archivedAt: null, deletedAt: "2026-08-03T00:00:00.000Z" })),
    ) as Record<string, unknown>;
    expect(parsed["deleted"]).toBe(true);
    expect(parsed["deletedAt"]).toBe("2026-08-03T00:00:00.000Z");
    expect(parsed["archivedAt"]).toBeNull();
  });

  it("ends with a newline so the file diffs cleanly", () => {
    expect(renderSessionManifest(input()).endsWith("\n")).toBe(true);
  });
});

describe("summarizeMessageSenders", () => {
  it("groups by role and sender, largest first", () => {
    const senders = summarizeMessageSenders([
      { role: "assistant", sentByUserId: null },
      { role: "assistant", sentByUserId: null },
      { role: "assistant", sentByUserId: null },
      { role: "user", sentByUserId: "user-1" },
      { role: "user", sentByUserId: "user-2" },
      { role: "user", sentByUserId: "user-1" },
    ]);
    expect(senders).toEqual([
      { userId: null, role: "assistant", messageCount: 3 },
      { userId: "user-1", role: "user", messageCount: 2 },
      { userId: "user-2", role: "user", messageCount: 1 },
    ]);
  });

  it("returns empty for no messages", () => {
    expect(summarizeMessageSenders([])).toEqual([]);
  });
});
