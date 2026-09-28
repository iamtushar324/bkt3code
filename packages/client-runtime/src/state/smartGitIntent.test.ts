// T3-CUSTOM(expbkt3): smart git button model (mirrors upstream's resolveQuickAction cases).
import type { VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSmartGitPrompt,
  isSmartGitPromptIntent,
  resolveSmartGitBaseBranch,
  resolveSmartGitDelivery,
  resolveSmartGitIntent,
  smartGitPromptForStatus,
  smartGitToastTitle,
  type SmartGitIntent,
  type SmartGitIntentOptions,
} from "./smartGitIntent.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

function openPr(number = 10): NonNullable<VcsStatusResult["pr"]> {
  return {
    number,
    title: "Open PR",
    url: `https://example.com/pr/${number}`,
    baseRef: "main",
    headRef: "feature/test",
    state: "open",
  };
}

const dirty = {
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [
      { path: "a.ts", insertions: 1, deletions: 0 },
      { path: "b.ts", insertions: 2, deletions: 1 },
      { path: "c.ts", insertions: 0, deletions: 4 },
    ],
    insertions: 3,
    deletions: 5,
  },
} satisfies Partial<VcsStatusResult>;

const defaults: SmartGitIntentOptions = {
  isBusy: false,
  isDefaultRef: false,
  hasPrimaryRemote: true,
};

interface Case {
  readonly name: string;
  readonly status: VcsStatusResult | null;
  readonly options?: Partial<SmartGitIntentOptions>;
  readonly expected: SmartGitIntent;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "busy",
    status: status(dirty),
    options: { isBusy: true },
    expected: {
      intent: "none",
      highlighted: false,
      label: "Commit",
      hint: "Git action in progress.",
    },
  },
  {
    name: "status unavailable",
    status: null,
    expected: {
      intent: "none",
      highlighted: false,
      label: "Commit",
      hint: "Git status is unavailable.",
    },
  },
  {
    name: "not a repository",
    status: status({ isRepo: false }),
    expected: {
      intent: "none",
      highlighted: false,
      label: "Commit",
      hint: "This workspace is not a git repository.",
    },
  },
  {
    name: "detached head",
    status: status({ ...dirty, refName: null }),
    expected: {
      intent: "none",
      highlighted: false,
      label: "Commit",
      hint: "Create and checkout a ref before pushing or opening a pull request.",
    },
  },
  {
    name: "dirty feature branch",
    status: status(dirty),
    expected: { intent: "commit", highlighted: true, label: "Commit", hint: "3 files changed" },
  },
  {
    name: "dirty with one file",
    status: status({
      ...dirty,
      workingTree: {
        files: [{ path: "a.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
    }),
    expected: { intent: "commit", highlighted: true, label: "Commit", hint: "1 file changed" },
  },
  {
    name: "dirty with an open PR",
    status: status({ ...dirty, aheadCount: 1, pr: openPr() }),
    expected: { intent: "commit", highlighted: true, label: "Commit", hint: "3 files changed" },
  },
  {
    name: "dirty on the default ref",
    status: status({ ...dirty, isDefaultRef: true, refName: "main" }),
    options: { isDefaultRef: true },
    expected: {
      intent: "commit",
      highlighted: true,
      label: "Commit",
      hint: "3 files changed on the default branch",
    },
  },
  {
    name: "dirty without upstream or remote",
    status: status({ ...dirty, hasUpstream: false, hasPrimaryRemote: false }),
    options: { hasPrimaryRemote: false },
    expected: { intent: "commit", highlighted: true, label: "Commit", hint: "3 files changed" },
  },
  {
    name: "dirty, behind and diverged still commits first",
    status: status({ ...dirty, aheadCount: 2, behindCount: 1 }),
    expected: { intent: "commit", highlighted: true, label: "Commit", hint: "3 files changed" },
  },
  {
    name: "clean, no upstream, no remote",
    status: status({ hasUpstream: false, hasPrimaryRemote: false, aheadCount: 2 }),
    options: { hasPrimaryRemote: false },
    expected: {
      intent: "none",
      highlighted: false,
      label: "Publish repository",
      hint: "Add a remote before pushing.",
    },
  },
  {
    name: "clean, no upstream, no remote, open PR, nothing ahead",
    status: status({ hasUpstream: false, hasPrimaryRemote: false, pr: openPr(4) }),
    options: { hasPrimaryRemote: false },
    expected: { intent: "view_pr", highlighted: false, label: "View PR", hint: "PR #4 is open" },
  },
  {
    name: "clean, no upstream, nothing ahead",
    status: status({ hasUpstream: false }),
    expected: {
      intent: "none",
      highlighted: false,
      label: "Push",
      hint: "No local commits to push.",
    },
  },
  {
    name: "clean, no upstream, nothing ahead, open PR",
    status: status({ hasUpstream: false, pr: openPr(7) }),
    expected: { intent: "view_pr", highlighted: false, label: "View PR", hint: "PR #7 is open" },
  },
  {
    name: "clean, no upstream, ahead",
    status: status({ hasUpstream: false, aheadCount: 2 }),
    expected: {
      intent: "create_pr",
      highlighted: true,
      label: "Create PR",
      hint: "2 commits ahead of the default branch",
    },
  },
  {
    name: "clean, no upstream, ahead of the recorded worktree base",
    status: status({ hasUpstream: false, aheadCount: 2, aheadOfDefaultCount: 5, baseRef: "dev" }),
    expected: {
      intent: "create_pr",
      highlighted: true,
      label: "Create PR",
      hint: "5 commits ahead of dev",
    },
  },
  {
    name: "clean, no upstream, ahead, open PR",
    status: status({ hasUpstream: false, aheadCount: 1, pr: openPr(8) }),
    expected: {
      intent: "push",
      highlighted: true,
      label: "Push",
      hint: "1 commit not pushed to PR #8",
    },
  },
  {
    name: "clean, no upstream, ahead on the default ref",
    status: status({ hasUpstream: false, aheadCount: 2, isDefaultRef: true, refName: "main" }),
    options: { isDefaultRef: true },
    expected: { intent: "push", highlighted: true, label: "Push", hint: "2 commits not pushed" },
  },
  {
    name: "diverged",
    status: status({ aheadCount: 1, behindCount: 1 }),
    expected: {
      intent: "none",
      highlighted: false,
      label: "Sync ref",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    },
  },
  {
    name: "behind",
    status: status({ behindCount: 3 }),
    expected: {
      intent: "pull",
      highlighted: false,
      label: "Pull",
      hint: "3 commits behind upstream",
    },
  },
  {
    name: "ahead with an open PR",
    status: status({ aheadCount: 3, pr: openPr(13) }),
    expected: {
      intent: "push",
      highlighted: true,
      label: "Push",
      hint: "3 commits not pushed to PR #13",
    },
  },
  {
    name: "ahead on the default ref",
    status: status({ aheadCount: 1, isDefaultRef: true, refName: "main" }),
    options: { isDefaultRef: true },
    expected: { intent: "push", highlighted: true, label: "Push", hint: "1 commit not pushed" },
  },
  {
    name: "ahead without a PR",
    status: status({ aheadCount: 2 }),
    expected: {
      intent: "create_pr",
      highlighted: true,
      label: "Create PR",
      hint: "2 commits ahead of the default branch",
    },
  },
  {
    name: "clean with an open PR",
    status: status({ pr: openPr(10) }),
    expected: { intent: "view_pr", highlighted: false, label: "View PR", hint: "PR #10 is open" },
  },
  {
    name: "clean, pushed, ahead of default, no PR",
    status: status({ aheadOfDefaultCount: 4, baseRef: "main" }),
    expected: {
      intent: "create_pr",
      highlighted: true,
      label: "Create PR",
      hint: "4 commits ahead of main",
    },
  },
  {
    name: "clean default ref ahead of itself is not a PR",
    status: status({ aheadOfDefaultCount: 4, isDefaultRef: true, refName: "main" }),
    options: { isDefaultRef: true },
    expected: {
      intent: "none",
      highlighted: false,
      label: "Commit",
      hint: "Branch is up to date. No action needed.",
    },
  },
  {
    name: "up to date",
    status: status(),
    expected: {
      intent: "none",
      highlighted: false,
      label: "Commit",
      hint: "Branch is up to date. No action needed.",
    },
  },
  {
    name: "closed PR does not count as open",
    status: status({ aheadCount: 1, pr: { ...openPr(3), state: "closed" } }),
    expected: {
      intent: "create_pr",
      highlighted: true,
      label: "Create PR",
      hint: "1 commit ahead of main",
    },
  },
  {
    name: "GitLab wording",
    status: status({
      aheadCount: 2,
      sourceControlProvider: { kind: "gitlab", name: "GitLab", baseUrl: "https://gitlab.com" },
    }),
    expected: {
      intent: "create_pr",
      highlighted: true,
      label: "Create MR",
      hint: "2 commits ahead of the default branch",
    },
  },
];

describe("resolveSmartGitIntent", () => {
  it.each(cases)("$name", ({ status: gitStatus, options, expected }) => {
    expect(resolveSmartGitIntent(gitStatus, { ...defaults, ...options })).toEqual(expected);
  });

  it("highlights exactly the prompt intents", () => {
    for (const { status: gitStatus, options } of cases) {
      const intent = resolveSmartGitIntent(gitStatus, { ...defaults, ...options });
      expect(intent.highlighted).toBe(isSmartGitPromptIntent(intent.intent));
    }
  });
});

describe("resolveSmartGitBaseBranch", () => {
  it.each([
    { name: "no status", status: null, expected: null },
    { name: "nothing recorded", status: status(), expected: null },
    { name: "recorded worktree base", status: status({ baseRef: "dev" }), expected: "dev" },
    {
      name: "open PR base wins",
      status: status({ baseRef: "dev", pr: { ...openPr(), baseRef: "release" } }),
      expected: "release",
    },
  ])("$name", ({ status: gitStatus, expected }) => {
    expect(resolveSmartGitBaseBranch(gitStatus)).toBe(expected);
  });
});

describe("buildSmartGitPrompt", () => {
  it.each([
    {
      name: "commit",
      intent: "commit" as const,
      options: { baseBranch: "main", changeRequestTerm: "pull request" },
      expected:
        "Commit all current changes in this worktree with a clear, conventional commit message that explains why. Do not push.",
    },
    {
      name: "create PR against a known base",
      intent: "create_pr" as const,
      options: { baseBranch: "dev", changeRequestTerm: "pull request" },
      expected:
        "Push this branch and open a pull request against `dev` with a clear title and a description that summarises the changes and how they were tested. Reply with the pull request link.",
    },
    {
      name: "create MR against the default branch",
      intent: "create_pr" as const,
      options: { baseBranch: null, changeRequestTerm: "merge request" },
      expected:
        "Push this branch and open a merge request against the default branch with a clear title and a description that summarises the changes and how they were tested. Reply with the merge request link.",
    },
    {
      name: "push to an open PR",
      intent: "push" as const,
      options: {
        baseBranch: "main",
        changeRequestTerm: "pull request",
        hasOpenChangeRequest: true,
      },
      expected: "Push the new commits to the existing pull request and reply with its link.",
    },
    {
      name: "push a branch without a PR",
      intent: "push" as const,
      options: { baseBranch: null, changeRequestTerm: "pull request" },
      expected: "Push the new commits on this branch to its remote. Do not open a pull request.",
    },
  ])("$name", ({ intent, options, expected }) => {
    expect(buildSmartGitPrompt(intent, options)).toBe(expected);
  });
});

describe("smartGitPromptForStatus", () => {
  it("returns null for intents that are not prompts", () => {
    const gitStatus = status({ pr: openPr() });
    const intent = resolveSmartGitIntent(gitStatus, defaults);
    expect(intent.intent).toBe("view_pr");
    expect(smartGitPromptForStatus(intent, gitStatus)).toBeNull();
  });

  it("targets the open PR when pushing", () => {
    const gitStatus = status({ aheadCount: 1, pr: openPr() });
    const intent = resolveSmartGitIntent(gitStatus, defaults);
    expect(smartGitPromptForStatus(intent, gitStatus)).toBe(
      "Push the new commits to the existing pull request and reply with its link.",
    );
  });

  it("uses the recorded worktree base for a new PR", () => {
    const gitStatus = status({ aheadCount: 1, baseRef: "dev" });
    const intent = resolveSmartGitIntent(gitStatus, defaults);
    expect(smartGitPromptForStatus(intent, gitStatus)).toContain("against `dev`");
  });
});

describe("resolveSmartGitDelivery", () => {
  it.each([
    { turnRunning: false, queueStillSending: false, expected: "send" },
    { turnRunning: true, queueStillSending: false, expected: "queue" },
    { turnRunning: false, queueStillSending: true, expected: "queue" },
    { turnRunning: true, queueStillSending: true, expected: "queue" },
  ] as const)(
    "running=$turnRunning queued=$queueStillSending -> $expected",
    ({ expected, ...input }) => {
      expect(resolveSmartGitDelivery(input)).toBe(expected);
    },
  );
});

describe("smartGitToastTitle", () => {
  it.each([
    { intent: "commit", delivery: "send", expected: "Asked the agent to commit" },
    { intent: "push", delivery: "queue", expected: "Queued: will ask the agent to push" },
    { intent: "create_pr", delivery: "send", expected: "Asked the agent to open a PR" },
  ] as const)("$intent / $delivery", ({ intent, delivery, expected }) => {
    expect(smartGitToastTitle(intent, delivery, "PR")).toBe(expected);
  });
});
