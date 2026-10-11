import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  inboxCandidates,
  matchSessionRef,
  sessionStateOf,
  shortRef,
  type SessionShell,
} from "./view.ts";

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const at = (minutesAgo: number) => DateTime.makeUnsafe(NOW - minutesAgo * 60_000);

// Only the fields the toolkit reads; the rest of the shell does not matter here.
const shell = (fields: Partial<Record<string, unknown>>): SessionShell =>
  ({
    id: "11111111-2222-3333-4444-555555555555",
    projectId: "project-1",
    title: "A session",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "root" },
    status: "idle",
    activityRunStatus: null,
    activeRunId: null,
    pendingRuntimeRequest: null,
    hasPendingAsyncUserInput: false,
    hasActionableProposedPlan: false,
    latestRunCompletedAt: null,
    lastVisitedAt: null,
    updatedAt: at(5),
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

describe("shortRef", () => {
  it("uses the first 8 characters of the id's last UUID", () => {
    expect(shortRef("mcp:62a31cd2-c64d-45af-8d05-71c0879e525d")).toBe("62a31cd2");
    expect(shortRef("thread-without-uuid")).toBe("thread-without-uuid");
  });
});

describe("matchSessionRef", () => {
  const login = shell({
    id: "62a31cd2-c64d-45af-8d05-71c0879e525d",
    title: "Fix login redirect",
    linearLinks: [{ url: "https://linear.app/beknown/issue/TEC-1488", kind: "issue" }],
    pullRequests: [
      {
        host: "github.com",
        repository: "iamtushar324/bkt3code",
        number: 297,
        url: "https://github.com/iamtushar324/bkt3code/pull/297",
        source: "agent",
        linkedAt: "2026-10-11T00:00:00.000Z",
        snapshot: null,
        stack: null,
      },
    ],
  });
  const loginTests = shell({ id: "9f8e7d6c-0000-4000-8000-000000000000", title: "Login tests" });
  const all = [login, loginTests];

  it("finds a session by id, short id, link, ticket and pull request", () => {
    expect(matchSessionRef(login.id, all)).toEqual([login]);
    expect(matchSessionRef("62a31cd2", all)).toEqual([login]);
    expect(matchSessionRef(`https://bkt3.example/env-1/${login.id}`, all)).toEqual([login]);
    expect(matchSessionRef("tec-1488", all)).toEqual([login]);
    expect(matchSessionRef("https://linear.app/beknown/issue/TEC-1488/fix-login", all)).toEqual([
      login,
    ]);
    expect(matchSessionRef("https://github.com/iamtushar324/bkt3code/pull/297", all)).toEqual([
      login,
    ]);
  });

  it("prefers an exact title, then lists every title that contains the text", () => {
    expect(matchSessionRef("login tests", all)).toEqual([loginTests]);
    expect(matchSessionRef("login", all)).toEqual([login, loginTests]);
    expect(matchSessionRef("nothing like it", all)).toEqual([]);
  });
});

describe("inboxCandidates", () => {
  it("orders urgent first, then approvals, questions, plans, failures and unread", () => {
    const plan = shell({
      id: "plan",
      hasActionableProposedPlan: true,
      latestRunCompletedAt: at(30),
    });
    const question = shell({
      id: "question",
      pendingRuntimeRequest: { id: "r1", kind: "user_input", createdAt: at(10) },
      status: "waiting",
    });
    const approval = shell({
      id: "approval",
      pendingRuntimeRequest: { id: "r2", kind: "command", createdAt: at(2) },
      status: "waiting",
    });
    const urgentFailure = shell({ id: "failed", status: "failed", title: "URGENT: prod is down" });
    const unread = shell({
      id: "unread",
      status: "completed",
      latestRunCompletedAt: at(3),
      lastVisitedAt: at(20),
    });
    const { entries } = inboxCandidates([plan, question, approval, urgentFailure, unread], NOW, {
      includeSnoozed: false,
    });
    expect(entries.map((entry) => entry.shell.id)).toEqual([
      "failed",
      "approval",
      "question",
      "plan",
      "unread",
    ]);
  });

  it("hides plans in snoozed and settled sessions, but never a question", () => {
    const snoozedPlan = shell({
      id: "snoozed-plan",
      hasActionableProposedPlan: true,
      snoozedUntil: at(-60),
      snoozedAt: at(30),
    });
    const settledPlan = shell({
      id: "settled-plan",
      hasActionableProposedPlan: true,
      settledOverride: "settled",
      settledAt: at(60),
    });
    const settledQuestion = shell({
      id: "settled-question",
      settledOverride: "settled",
      settledAt: at(60),
      pendingRuntimeRequest: { id: "r3", kind: "user_input", createdAt: at(1) },
    });
    const result = inboxCandidates([snoozedPlan, settledPlan, settledQuestion], NOW, {
      includeSnoozed: false,
    });
    expect(result.entries.map((entry) => entry.shell.id)).toEqual(["settled-question"]);
    expect(result.hidden).toBe(2);
    expect(
      inboxCandidates([snoozedPlan, settledPlan], NOW, { includeSnoozed: true }).entries,
    ).toHaveLength(2);
  });

  it("skips the provider's own sign-in, running plans and subagents", () => {
    const signIn = shell({
      id: "sign-in",
      pendingRuntimeRequest: { id: "r4", kind: "auth_refresh", createdAt: at(1) },
    });
    const runningPlan = shell({
      id: "running-plan",
      hasActionableProposedPlan: true,
      activeRunId: "run-1",
      status: "running",
    });
    const subagent = shell({
      id: "subagent",
      status: "failed",
      lineage: {
        parentThreadId: "parent",
        relationshipToParent: "subagent",
        rootThreadId: "parent",
      },
    });
    expect(
      inboxCandidates([signIn, runningPlan, subagent], NOW, { includeSnoozed: false }).entries,
    ).toEqual([]);
  });
});

describe("sessionStateOf", () => {
  it("reads lifecycle shelves before activity", () => {
    expect(sessionStateOf(shell({ archivedAt: at(1) }), NOW)).toBe("archived");
    expect(sessionStateOf(shell({ activeRunId: "run-1", status: "running" }), NOW)).toBe("running");
    expect(
      sessionStateOf(
        shell({ pendingRuntimeRequest: { id: "r", kind: "command", createdAt: at(1) } }),
        NOW,
      ),
    ).toBe("waiting");
    expect(sessionStateOf(shell({ settledOverride: "settled", settledAt: at(1) }), NOW)).toBe(
      "settled",
    );
    expect(sessionStateOf(shell({}), NOW)).toBe("idle");
  });
});
