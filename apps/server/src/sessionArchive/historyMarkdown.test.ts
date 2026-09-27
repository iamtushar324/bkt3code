/**
 * T3-CUSTOM(expbkt3): Coverage for the exported session digest.
 *
 * These files are read by other agents, so the shape is a contract: the fenced
 * prompt blocks in particular have to survive prompts that themselves contain
 * fenced code, or every section after the first one is corrupt.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  renderSessionHistoryDigest,
  renderSessionHistoryIndex,
  toOneLineSummary,
  type SessionHistoryDigestInput,
} from "./historyMarkdown.ts";

const digestInput = (
  overrides: Partial<SessionHistoryDigestInput> = {},
): SessionHistoryDigestInput => ({
  threadId: "thread_abcdef123456",
  title: "Fix the resume resync seam",
  projectName: "t3code-bkmain",
  workspaceRoot: "/home/ubuntu/repos/t3code",
  worktreePath: "/home/ubuntu/.t3/dev/worktrees/t3code/feature",
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5",
  createdAt: "2026-07-01T10:00:00.000Z",
  archivedAt: "2026-07-09T18:30:00.000Z",
  rollingSummary: "Converged execution state on resume. Landed in PR #55.",
  turnSummaries: [{ summary: "Reproduced the stuck frame", createdAt: "2026-07-01T10:05:00.000Z" }],
  userPrompts: [{ text: "the thread hangs on resume", createdAt: "2026-07-01T10:00:00.000Z" }],
  git: {
    branch: "t3code/resume-resync",
    baseRef: "main",
    headSha: "b6dda6094",
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    hasUnpushedCommits: false,
    changedFiles: [{ path: "apps/server/src/ws.ts", status: "M" }],
  },
  messageCount: 42,
  transcriptFileName: "2026-07-09-fix-the-resume-resync-seam-thread_ab.jsonl",
  reclaimNote: "Worktree reclaimed (slim) on 2026-08-07.",
  ...overrides,
});

describe("renderSessionHistoryDigest", () => {
  it("leads with the title and the reclaim note", () => {
    const output = renderSessionHistoryDigest(digestInput());
    expect(output.startsWith("# Fix the resume resync seam\n")).toBe(true);
    expect(output).toContain("> Worktree reclaimed (slim) on 2026-08-07.");
  });

  it("carries the facts an agent cannot reconstruct", () => {
    const output = renderSessionHistoryDigest(digestInput());
    expect(output).toContain("**Branch:** t3code/resume-resync");
    expect(output).toContain("**HEAD:** b6dda6094");
    expect(output).toContain("clean and pushed");
    expect(output).toContain("`M` apps/server/src/ws.ts");
    expect(output).toContain("**Thread id:** `thread_abcdef123456`");
  });

  it("names the transcript sidecar and how to read it", () => {
    const output = renderSessionHistoryDigest(digestInput());
    expect(output).toContain("2026-07-09-fix-the-resume-resync-seam-thread_ab.jsonl");
    expect(output).toContain("Grep it rather than reading it whole.");
  });

  it("omits the sidecar line when sidecars are disabled", () => {
    const output = renderSessionHistoryDigest(digestInput({ transcriptFileName: null }));
    expect(output).not.toContain("Full transcript");
  });

  it("escapes a prompt that contains its own code fence", () => {
    const prompt = "run this:\n```ts\nconst x = 1;\n```\nthen tell me";
    const output = renderSessionHistoryDigest(
      digestInput({ userPrompts: [{ text: prompt, createdAt: "2026-07-01T10:00:00.000Z" }] }),
    );
    // The outer fence must be longer than any run inside the prompt, so the
    // sections after the prompt are still inside the document structure.
    expect(output).toContain("````text");
    expect(output).toContain("```ts");
  });

  it("numbers every prompt", () => {
    const output = renderSessionHistoryDigest(
      digestInput({
        userPrompts: [
          { text: "first", createdAt: "2026-07-01T10:00:00.000Z" },
          { text: "second", createdAt: "2026-07-01T11:00:00.000Z" },
        ],
      }),
    );
    expect(output).toContain("## Prompts (2)");
    expect(output).toContain("### 1. 2026-07-01T10:00:00.000Z");
    expect(output).toContain("### 2. 2026-07-01T11:00:00.000Z");
  });

  it("flags the risky states plainly", () => {
    const output = renderSessionHistoryDigest(
      digestInput({
        git: {
          branch: "wip",
          baseRef: null,
          headSha: null,
          hasUncommittedChanges: true,
          hasUntrackedFiles: true,
          hasUnpushedCommits: true,
          changedFiles: [],
        },
      }),
    );
    expect(output).toContain("uncommitted changes, untracked files, unpushed commits");
  });

  it("survives a session with no summary, no git, and no prompts", () => {
    const output = renderSessionHistoryDigest(
      digestInput({
        rollingSummary: null,
        turnSummaries: [],
        userPrompts: [],
        git: null,
        reclaimNote: null,
        title: "   ",
      }),
    );
    expect(output).toContain("# Untitled session");
    expect(output).toContain("No git information was captured");
  });

  it("skips turn summaries that never became ready", () => {
    const output = renderSessionHistoryDigest(
      digestInput({
        turnSummaries: [
          { summary: null, createdAt: "2026-07-01T10:05:00.000Z" },
          { summary: "  ", createdAt: "2026-07-01T10:06:00.000Z" },
        ],
      }),
    );
    expect(output).not.toContain("## Turn by turn");
  });
});

describe("renderSessionHistoryIndex", () => {
  it("sorts newest first and links each digest", () => {
    const output = renderSessionHistoryIndex("t3code-bkmain", [
      {
        fileName: "2026-07-01-older.md",
        title: "Older work",
        archivedAt: "2026-07-01T00:00:00.000Z",
        branch: "a",
        oneLineSummary: "Did the older thing.",
      },
      {
        fileName: "2026-08-01-newer.md",
        title: "Newer work",
        archivedAt: "2026-08-01T00:00:00.000Z",
        branch: "b",
        oneLineSummary: "Did the newer thing.",
      },
    ]);
    expect(output.indexOf("Newer work")).toBeLessThan(output.indexOf("Older work"));
    expect(output).toContain("[Newer work](2026-08-01-newer.md)");
  });

  it("escapes pipes so a title cannot break the table", () => {
    const output = renderSessionHistoryIndex("proj", [
      {
        fileName: "x.md",
        title: "fix a | b parsing",
        archivedAt: null,
        branch: null,
        oneLineSummary: null,
      },
    ]);
    expect(output).toContain("fix a \\| b parsing");
  });
});

describe("toOneLineSummary", () => {
  it("takes the first sentence", () => {
    expect(toOneLineSummary("Landed the fix. Then cleaned up.")).toBe("Landed the fix.");
  });

  it("collapses whitespace across lines", () => {
    expect(toOneLineSummary("Landed\n  the   fix")).toBe("Landed the fix");
  });

  it("truncates a long sentence with an ellipsis", () => {
    expect(toOneLineSummary("a".repeat(300))?.endsWith("…")).toBe(true);
  });

  it("maps empty input to null", () => {
    expect(toOneLineSummary(null)).toBeNull();
    expect(toOneLineSummary("   ")).toBeNull();
  });
});
