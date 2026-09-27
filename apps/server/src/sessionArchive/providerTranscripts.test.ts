/**
 * T3-CUSTOM(expbkt3): Coverage for raw provider transcript resolution.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  claudeProjectsDir,
  claudeTranscriptCandidate,
  codexSessionsDir,
  parseResumeSessionId,
  parseRuntimeCwd,
} from "./providerTranscripts.ts";

describe("parseResumeSessionId", () => {
  it("reads a Claude cursor's resume field", () => {
    expect(
      parseResumeSessionId("claudeAgent", {
        threadId: "t-1",
        resume: "1b2b4762-d917-4c6c-b052-9f1261fffeef",
        turnCount: 2,
      }),
    ).toBe("1b2b4762-d917-4c6c-b052-9f1261fffeef");
  });

  it("reads a Codex cursor's threadId field", () => {
    expect(
      parseResumeSessionId("codex", { threadId: "019f6c87-5451-7a03-9386-4934a512ca2e" }),
    ).toBe("019f6c87-5451-7a03-9386-4934a512ca2e");
  });

  it("returns null for unknown providers, null cursors, and wrong shapes", () => {
    expect(parseResumeSessionId("cursor", { resume: "abc" })).toBeNull();
    expect(parseResumeSessionId("claudeAgent", null)).toBeNull();
    expect(parseResumeSessionId("claudeAgent", "not-an-object")).toBeNull();
    expect(parseResumeSessionId("claudeAgent", { resume: 42 })).toBeNull();
    expect(parseResumeSessionId("codex", { resume: "wrong-field" })).toBeNull();
    expect(parseResumeSessionId("claudeAgent", { resume: "   " })).toBeNull();
  });
});

describe("parseRuntimeCwd", () => {
  it("reads the cwd string from a runtime payload", () => {
    expect(parseRuntimeCwd({ cwd: "/home/u/worktrees/x", model: "m" })).toBe("/home/u/worktrees/x");
  });

  it("returns null for missing, blank, or non-string cwd", () => {
    expect(parseRuntimeCwd(null)).toBeNull();
    expect(parseRuntimeCwd({})).toBeNull();
    expect(parseRuntimeCwd({ cwd: "" })).toBeNull();
    expect(parseRuntimeCwd({ cwd: 7 })).toBeNull();
  });
});

describe("provider transcript locations", () => {
  it("uses ~/.claude/projects when no home is configured", () => {
    expect(claudeProjectsDir(null, "/home/u")).toBe("/home/u/.claude/projects");
  });

  it("treats a configured Claude home as the config dir itself", () => {
    expect(claudeProjectsDir("/srv/claude-a", "/home/u")).toBe("/srv/claude-a/projects");
  });

  it("uses ~/.codex/sessions when no home is configured", () => {
    expect(codexSessionsDir(null, "/home/u")).toBe("/home/u/.codex/sessions");
  });

  it("treats a configured Codex home as the .codex dir itself", () => {
    expect(codexSessionsDir("/srv/codex-a", "/home/u")).toBe("/srv/codex-a/sessions");
  });

  it("builds the Claude transcript path from the slugified cwd", () => {
    // The slug rule must match Claude Code's own: `/` and `.` become `-`.
    expect(
      claudeTranscriptCandidate({
        projectsDir: "/home/u/.claude/projects",
        cwd: "/home/u/.t3/bkt3-dev/worktrees/repo/task-1",
        sessionId: "6ffe4fed-8832-4217-8628-fe063256e7b0",
      }),
    ).toBe(
      "/home/u/.claude/projects/-home-u--t3-bkt3-dev-worktrees-repo-task-1/6ffe4fed-8832-4217-8628-fe063256e7b0.jsonl",
    );
  });
});
