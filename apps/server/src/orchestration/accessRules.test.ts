import type {
  OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  UserId,
} from "@t3tools/contracts";
import { ProjectId, ThreadId, UserId as UserIdSchema } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { filterShellSnapshot, isThreadAssignedToUser } from "./accessRules.ts";

const uid = (value: string): UserId => UserIdSchema.make(value);
const OWNER = uid("user_owner");
const ALICE = uid("user_alice");
const BOB = uid("user_bob");

const NOW = "2026-03-01T00:00:00.000Z";

const project = (
  id: string,
  ownerUserId: UserId | null,
  memberUserIds: ReadonlyArray<UserId>,
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title: id,
  workspaceRoot: `/tmp/${id}`,
  defaultModelSelection: null,
  scripts: [],
  ownerUserId,
  memberUserIds,
  createdAt: NOW,
  updatedAt: NOW,
});

const thread = (
  id: string,
  projectId: string,
  ownerUserId: UserId | null,
  memberUserIds: ReadonlyArray<UserId>,
): OrchestrationThreadShell => ({
  // T3-CUSTOM(expbkt3): upstream's linked pull requests; empty on a fresh fixture.
  pullRequests: [],
  id: ThreadId.make(id),
  projectId: ProjectId.make(projectId),
  title: id,
  modelSelection: { instanceId: "codex" as never, model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  sourceControlProfileId: null,
  latestTurn: null,
  ownerUserId,
  memberUserIds,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const snapshot = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 1,
  projects,
  threads,
  updatedAt: NOW,
});

describe("accessRules.filterShellSnapshot", () => {
  it("owner sees their own project and threads", () => {
    const snap = snapshot(
      [project("p1", OWNER, [])],
      [thread("t1", "p1", OWNER, []), thread("t2", "p1", OWNER, [])],
    );
    const filtered = filterShellSnapshot(snap, OWNER);
    expect(filtered.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(filtered.threads.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
  });

  it("a non-member sees nothing", () => {
    const snap = snapshot([project("p1", OWNER, [])], [thread("t1", "p1", OWNER, [])]);
    const filtered = filterShellSnapshot(snap, BOB);
    expect(filtered.projects).toEqual([]);
    expect(filtered.threads).toEqual([]);
  });

  it("a thread tag reveals that thread + its project container, but NOT sibling threads", () => {
    const snap = snapshot(
      [project("p1", OWNER, [])],
      [thread("t1", "p1", OWNER, [ALICE]), thread("t2", "p1", OWNER, [])],
    );
    const filtered = filterShellSnapshot(snap, ALICE);
    expect(filtered.threads.map((t) => t.id)).toEqual(["t1"]);
    // The project appears as a container so t1 can be grouped under it.
    expect(filtered.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("a project tag reveals the project only, NOT its threads", () => {
    const snap = snapshot(
      [project("p1", OWNER, [ALICE])],
      [thread("t1", "p1", OWNER, []), thread("t2", "p1", OWNER, [])],
    );
    const filtered = filterShellSnapshot(snap, ALICE);
    // Project appears (Alice is a project member) but none of its threads.
    expect(filtered.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(filtered.threads).toEqual([]);
  });

  it("a project tag + a direct thread tag shows the project and only the tagged thread", () => {
    const snap = snapshot(
      [project("p1", OWNER, [ALICE])],
      [thread("t1", "p1", OWNER, [ALICE]), thread("t2", "p1", OWNER, [])],
    );
    const filtered = filterShellSnapshot(snap, ALICE);
    expect(filtered.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(filtered.threads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("isThreadAssignedToUser is owner-or-direct-tag only (not project-tag)", () => {
    const projectTaggedThread = thread("t1", "p1", OWNER, []);
    // Alice is only tagged on the project, not the thread.
    expect(isThreadAssignedToUser(projectTaggedThread, ALICE)).toBe(false);
    expect(isThreadAssignedToUser(thread("t2", "p1", OWNER, [ALICE]), ALICE)).toBe(true);
    expect(isThreadAssignedToUser(thread("t3", "p1", ALICE, []), ALICE)).toBe(true);
  });
});
