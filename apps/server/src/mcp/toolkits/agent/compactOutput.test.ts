// T3-CUSTOM(expbkt3): TEC-1818. Agent-toolkit results are short by default
// (tickets and pull requests counted), detail "full" keeps today's output,
// and every next-call hint names the full session id, which always resolves.
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { PendingQuestion } from "./pending.ts";
import {
  compactTagsOf,
  renderInboxEntry,
  renderSessionLine,
  sessionHeading,
  sessionTagsData,
  tagsOf,
} from "./render.ts";
import { matchSessionRef, shortRef, type SessionShell } from "./view.ts";

const NOW = Date.UTC(2026, 9, 28, 7, 0, 0);
const at = (minutesAgo: number) => DateTime.makeUnsafe(NOW - minutesAgo * 60_000);

const pr = (number: number, state: "open" | "merged" | "closed", checksState: string | null) => ({
  repository: "iamtushar324/bkt3code",
  number,
  url: `https://github.com/iamtushar324/bkt3code/pull/${number}`,
  source: "manual",
  snapshot: { state, checksState },
});

const issue = (key: string) => ({
  url: `https://linear.app/beknown/issue/${key}/x`,
  kind: "issue",
});

// Only the fields the renderers read.
const shell = (fields: Partial<Record<string, unknown>>): SessionShell =>
  ({
    id: "86157111-97e0-449f-9a7e-f65b82072544",
    title: "Compact output",
    status: "idle",
    activityRunStatus: null,
    activeRunId: null,
    activityRunStartedAt: null,
    pendingRuntimeRequest: null,
    hasPendingAsyncUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    latestRunCompletedAt: null,
    lastVisitedAt: null,
    updatedAt: at(1),
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    priority: null,
    linearLinks: [],
    pullRequests: [],
    ...fields,
  }) as unknown as SessionShell;

const busy = shell({
  linearLinks: [issue("TEC-1818"), issue("TEC-1624")],
  pullRequests: [pr(301, "open", "passing"), pr(300, "merged", "passing"), pr(299, "closed", null)],
});

describe("session heading detail", () => {
  it("counts tickets and pull requests by default", () => {
    const heading = sessionHeading(busy, { projectTitle: null, link: null, nowMs: NOW });
    expect(heading).toBe("`86157111` **Compact output** · 2 tickets · 3 PRs (1 open)");
    expect(compactTagsOf(busy)).toBe("2 tickets · 3 PRs (1 open)");
  });

  it("shows a single ticket and pull request as themselves", () => {
    const one = shell({
      linearLinks: [issue("TEC-1818")],
      pullRequests: [pr(301, "open", "passing")],
    });
    expect(compactTagsOf(one)).toBe("TEC-1818 · PR #301 (open, checks passing)");
  });

  it("keeps today's output at detail full", () => {
    const heading = sessionHeading(busy, {
      projectTitle: null,
      link: null,
      nowMs: NOW,
      detail: "full",
    });
    expect(heading).toBe(`\`86157111\` **Compact output** · ${tagsOf(busy)}`);
    expect(tagsOf(busy)).toBe(
      "TEC-1818 · TEC-1624 · PR #301 (open, checks passing) · PR #300 (merged, checks passing) · PR #299 (closed)",
    );
  });

  it("puts the compact heading on each t3_find_sessions line", () => {
    const line = renderSessionLine(1, busy, { projectTitle: "bkt3", link: null, nowMs: NOW });
    expect(line.split("\n")[0]).toBe(
      "1. `86157111` **Compact output** · project bkt3 · 2 tickets · 3 PRs (1 open) — idle, last change 1m ago",
    );
  });
});

describe("session tags as data", () => {
  it("replaces the lists with counts by default", () => {
    expect(sessionTagsData(busy, undefined)).toEqual({
      linearCount: 2,
      pullRequestCount: 3,
      openPullRequestCount: 1,
    });
    expect(sessionTagsData(busy, "compact")).toEqual(sessionTagsData(busy, undefined));
  });

  it("keeps the lists at detail full", () => {
    const data = sessionTagsData(busy, "full");
    const linear = "linear" in data ? data.linear : null;
    const numbers = "pullRequests" in data ? data.pullRequests.map((item) => item.number) : null;
    expect(linear).toEqual(["TEC-1818", "TEC-1624"]);
    expect(numbers).toEqual([301, 300, 299]);
  });
});

describe("next-call hints", () => {
  // Two subagents of one parent: delegated-task ids whose short refs can collide.
  const parent = "11111111-2222-3333-4444-555555555555";
  const child = shell({
    id: `thread:delegated-task:${parent}:aaaaaaaa-0000-4000-8000-000000000001`,
    title: "Child one",
    hasPendingAsyncUserInput: true,
  });
  const sibling = shell({
    id: `thread:delegated-task:${parent}:aaaaaaaa-0000-4000-8000-000000000002`,
    title: "Child two",
  });

  const question: PendingQuestion = {
    requestId: "runtime-request:codex:native-request:async:9e9c4c3e-50f1-4f9e-a521-b41c3a04c7af",
    questions: [
      {
        id: "0",
        header: "Pick",
        question: "Which one?",
        options: [
          { label: "A", description: "A" },
          { label: "B", description: "B" },
        ],
      },
    ],
    textOnly: false,
    async: true,
    askedAt: null,
  };

  it("a short ref can match several sessions, the full id only one", () => {
    expect(shortRef(child.id)).toBe(shortRef(sibling.id));
    expect(matchSessionRef(shortRef(child.id), [child, sibling])).toHaveLength(2);
    expect(matchSessionRef(child.id, [child, sibling])).toEqual([child]);
  });

  it("names the full session id in t3_inbox hints, keeping the short ref for display", () => {
    const text = renderInboxEntry(1, {
      kind: "async-question",
      shell: child,
      context: { projectTitle: null, link: null, nowMs: NOW },
      waitingSinceMs: NOW - 60_000,
      question,
      approval: null,
      secret: null,
      moreQuestions: 1,
      plan: null,
      lastReply: null,
    });
    expect(text).toContain("`aaaaaaaa` **Child one**");
    expect(text).toContain(`t3_answer {"session":"${child.id}","requestId":"9e9c4c3e","choice":1}`);
    expect(text).toContain(`t3_session_brief {"session":"${child.id}"}`);
    expect(text).not.toContain('"session":"aaaaaaaa"');
    // The question's options and request id are never dropped in compact output.
    expect(text).toContain("1. A");
    expect(text).toContain("2. B");
  });
});
