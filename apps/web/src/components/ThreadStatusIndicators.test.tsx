import { ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { resolveWorktreeCodename } from "@t3tools/shared/worktreeCodename";

import { ThreadWorktreeIndicator, linkedPullRequestSnapshotStatus } from "./ThreadStatusIndicators";

describe("ThreadWorktreeIndicator", () => {
  it("leads the accessible label with the worktree codename", () => {
    const worktreePath = "/tmp/worktrees/sidebar-indicator";
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath,
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      `aria-label="Worktree ${resolveWorktreeCodename(worktreePath)} (feature/sidebar-indicator) · sidebar-indicator"`,
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it("keeps the codename when the thread has no branch", () => {
    const worktreePath = "/tmp/worktrees/t3code-2d633e64";
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: null,
          worktreePath,
        }}
      />,
    );

    expect(markup).toContain(
      `aria-label="Worktree ${resolveWorktreeCodename(worktreePath)} · t3code-2d633e64"`,
    );
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});

describe("linked pull request snapshots", () => {
  const link: ThreadPullRequestLink = {
    host: "gitlab.example.com",
    repository: "acme/web",
    number: 42,
    url: "https://gitlab.example.com/acme/web/-/merge_requests/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unsynced links unknown", () => {
    expect(linkedPullRequestSnapshotStatus(link)).toBeNull();
  });
  it("uses the snapshot state and branches with the linked identity", () => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      snapshot: {
        state: "merged",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result).toEqual({
      pr: {
        number: 42,
        url: link.url,
        title: "Change",
        state: "merged",
        isDraft: false,
        headRef: "feature",
        baseRef: "main",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      sourceControlProvider: { kind: "gitlab", name: "gitlab", baseUrl: "" },
    });
  });
});
