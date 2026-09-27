/**
 * T3-CUSTOM(expbkt3): Coverage for the context handoff digest.
 *
 * The digest is pasted as a new session's first prompt, so its shape is a
 * contract with the receiving agent: fenced transcript blocks must survive
 * messages that contain fences themselves, and the size cap must keep the
 * newest messages plus the original goal rather than a silent arbitrary slice.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  renderThreadContextDigest,
  selectTranscriptMessages,
  type ContextTranscriptMessage,
  type ThreadContextDigestInput,
} from "./contextDigest.ts";

const message = (
  role: string,
  text: string,
  createdAt = "2026-08-01T10:00:00.000Z",
): ContextTranscriptMessage => ({ role, text, createdAt });

const digestInput = (
  overrides: Partial<ThreadContextDigestInput> = {},
): ThreadContextDigestInput => ({
  threadId: "thread_abcdef123456",
  title: "Fix the resume resync seam",
  projectName: "t3code-bkmain",
  workspaceRoot: "/home/ubuntu/repos/t3code",
  worktreePath: "/home/ubuntu/.t3/dev/worktrees/t3code/feature",
  branch: "t3code/resume-resync",
  providerInstanceId: "claudeAgent",
  model: "claude-opus-5",
  createdAt: "2026-08-01T10:00:00.000Z",
  git: {
    branch: "t3code/resume-resync",
    baseRef: "main",
    headSha: "b6dda6094",
    hasUncommittedChanges: true,
    hasUntrackedFiles: false,
    hasUnpushedCommits: true,
    changedFiles: [{ path: "apps/server/src/ws.ts", status: "M" }],
  },
  messages: [
    message("user", "the thread hangs on resume"),
    message("assistant", "Found the stuck frame in the resume path."),
  ],
  ...overrides,
});

describe("renderThreadContextDigest", () => {
  it("leads with the handoff preamble and carries the session facts", () => {
    const { markdown, truncated } = renderThreadContextDigest(digestInput());
    expect(markdown.startsWith("# Session handoff — continue this work\n")).toBe(true);
    expect(markdown).toContain("- **Title:** Fix the resume resync seam");
    expect(markdown).toContain("- **Branch:** t3code/resume-resync");
    expect(markdown).toContain("- **Source thread id:** `thread_abcdef123456`");
    expect(markdown).toContain("## Git state");
    expect(markdown).toContain("uncommitted changes, unpushed commits");
    expect(markdown).toContain("- `M` apps/server/src/ws.ts");
    expect(truncated).toBe(false);
  });

  it("labels transcript roles and fences message bodies against embedded fences", () => {
    const { markdown } = renderThreadContextDigest(
      digestInput({
        messages: [
          message("user", "please fix\n```ts\nconst x = 1;\n```\nthanks"),
          message("assistant", "done"),
        ],
      }),
    );
    expect(markdown).toContain("### User — 2026-08-01T10:00:00.000Z");
    expect(markdown).toContain("### Assistant — 2026-08-01T10:00:00.000Z");
    // The outer fence must be longer than the embedded three-backtick fence.
    expect(markdown).toContain("````text");
  });

  it("renders an explicit empty-transcript marker and dashes for missing facts", () => {
    const { markdown } = renderThreadContextDigest(
      digestInput({
        messages: [],
        git: null,
        worktreePath: null,
        branch: null,
      }),
    );
    expect(markdown).toContain("This session had no messages yet.");
    expect(markdown).toContain("No git information was captured for this session.");
    expect(markdown).toContain("- **Worktree:** —");
  });

  it("elides the middle of the transcript but pins the first user prompt", () => {
    const filler = "x".repeat(5_000);
    const messages: Array<ContextTranscriptMessage> = [
      message("user", "ORIGINAL GOAL: make resume work"),
      ...Array.from({ length: 30 }, (_, index) => message("assistant", `${filler} step ${index}`)),
      message("assistant", "FINAL STATE: nearly done"),
    ];
    const { markdown, truncated } = renderThreadContextDigest(digestInput({ messages }));
    expect(truncated).toBe(true);
    expect(markdown).toContain("ORIGINAL GOAL: make resume work");
    expect(markdown).toContain("FINAL STATE: nearly done");
    expect(markdown).toContain("omitted to fit the size cap");
  });

  it("clamps a single oversized message from the middle", () => {
    const { kept } = selectTranscriptMessages([message("user", "a".repeat(40_000))]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.clampedText.length).toBeLessThan(14_000);
    expect(kept[0]!.clampedText).toContain("characters elided from the middle");
  });

  it("keeps the newest messages when the budget forces a choice", () => {
    const filler = "y".repeat(6_000);
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(index % 2 === 0 ? "user" : "assistant", `${filler} marker-${index}`),
    );
    const { kept, omittedCount } = selectTranscriptMessages(messages);
    expect(omittedCount).toBeGreaterThan(0);
    const keptMarkers = kept.map((entry) => entry.clampedText.slice(-10));
    expect(keptMarkers.at(-1)).toContain("marker-19");
  });
});
