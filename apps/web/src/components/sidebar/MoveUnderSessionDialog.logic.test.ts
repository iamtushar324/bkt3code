// T3-CUSTOM(expbkt3): "move under session" candidate coverage.
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadShell } from "../../types";
import {
  collectDescendantThreadIds,
  resolveMoveUnderCandidates,
} from "./MoveUnderSessionDialog.logic";

const environmentId = EnvironmentId.make("environment-local");
const otherEnvironmentId = EnvironmentId.make("environment-remote");

function makeThread(
  id: string,
  options: {
    readonly parent?: string | null;
    readonly archived?: boolean;
    readonly updatedAt?: string;
    readonly environment?: EnvironmentId;
    readonly title?: string;
  } = {},
): ThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: options.environment ?? environmentId,
    projectId: ProjectId.make("project-1"),
    title: options.title ?? `Thread ${id}`,
    parentThreadId: options.parent == null ? null : ThreadId.make(options.parent),
    archivedAt: options.archived ? "2026-01-01T00:00:00.000Z" : null,
    updatedAt: options.updatedAt ?? "2026-01-01T00:00:00.000Z",
  } as unknown as ThreadShell;
}

const repositoryLabelFor = () => "repo-one";

describe("collectDescendantThreadIds", () => {
  it("walks the whole subtree", () => {
    const threads = [
      makeThread("root"),
      makeThread("child", { parent: "root" }),
      makeThread("grandchild", { parent: "child" }),
    ];

    // T3-CUSTOM(expbkt3): descendants are (environment, thread) pairs, because a
    // lineage can cross environments and a bare id is ambiguous across them.
    expect([...collectDescendantThreadIds(threads, "root")].toSorted()).toEqual([
      `${environmentId}:child`,
      `${environmentId}:grandchild`,
    ]);
  });

  it("terminates on a corrupt cycle", () => {
    const threads = [makeThread("a", { parent: "b" }), makeThread("b", { parent: "a" })];

    expect([...collectDescendantThreadIds(threads, "a")].toSorted()).toEqual([
      `${environmentId}:b`,
    ]);
  });
});

describe("resolveMoveUnderCandidates", () => {
  const subject = makeThread("subject", { parent: "current-parent" });
  const threads = [
    subject,
    makeThread("current-parent"),
    makeThread("child", { parent: "subject" }),
    makeThread("grandchild", { parent: "child" }),
    makeThread("eligible", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    makeThread("older", { updatedAt: "2026-01-05T00:00:00.000Z" }),
    makeThread("archived", { archived: true }),
    makeThread("elsewhere", { environment: otherEnvironmentId }),
  ];

  const ids = (query = "") =>
    resolveMoveUnderCandidates({ threads, subject, query, repositoryLabelFor }).map(
      (candidate) => candidate.thread.id,
    );

  it("never offers the thread itself", () => {
    expect(ids()).not.toContain("subject");
  });

  it("never offers a descendant, because the server would reject the cycle", () => {
    expect(ids()).not.toContain("child");
    expect(ids()).not.toContain("grandchild");
  });

  it("omits the current parent, which is already where the thread sits", () => {
    expect(ids()).not.toContain("current-parent");
  });

  it("omits archived threads", () => {
    expect(ids()).not.toContain("archived");
  });

  // T3-CUSTOM(expbkt3): a parent may live on another machine, so the picker
  // offers it — spreading work across hosts is the case this exists for.
  it("offers threads from another environment", () => {
    expect(ids()).toContain("elsewhere");
  });

  it("orders the most recently touched session first", () => {
    expect(ids()).toEqual(["eligible", "older", "elsewhere"]);
  });

  it("filters by title, case-insensitively", () => {
    const matches = resolveMoveUnderCandidates({
      threads: [subject, makeThread("hit", { title: "Migrate Billing" }), makeThread("miss")],
      subject,
      query: "billing",
      repositoryLabelFor,
    });

    expect(matches.map((candidate) => candidate.thread.id)).toEqual(["hit"]);
  });

  it("honours the result limit", () => {
    const many = Array.from({ length: 80 }, (_, index) => makeThread(`t-${index}`));

    expect(
      resolveMoveUnderCandidates({
        threads: [subject, ...many],
        subject,
        query: "",
        repositoryLabelFor,
        limit: 10,
      }),
    ).toHaveLength(10);
  });
});
