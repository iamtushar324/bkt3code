/**
 * T3-CUSTOM(expbkt3): Coverage for the two "something is using this" protections.
 *
 * The server-owned case matters most on the deployment box, where T3 Code runs
 * out of a worktree that often has no thread pointing at it — nothing in the
 * projection would protect it, so this function has to.
 */
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { collectWorktreeUsage, serverOwnedWorktrees } from "./liveWorktrees.ts";

const WORKTREES_DIR = "/home/ubuntu/.t3/bkt3-dev/worktrees";

/**
 * `execution` and `session` are optional-key fields, so `Partial<…>` rejects the
 * partial stubs these cases need under `exactOptionalPropertyTypes`. The shape
 * under test reads five fields; the cast keeps the fixtures to those five.
 */
const thread = (overrides: Record<string, unknown>): OrchestrationThreadShell =>
  ({
    id: "thread_1",
    worktreePath: `${WORKTREES_DIR}/proj/one`,
    archivedAt: "2026-01-01T00:00:00.000Z",
    session: null,
    execution: null,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

describe("collectWorktreeUsage", () => {
  it("treats a running session's worktree as live", () => {
    const usage = collectWorktreeUsage([
      thread({ session: { status: "running" } as OrchestrationThreadShell["session"] }),
    ]);
    expect(usage.liveWorktreePaths.has(`${WORKTREES_DIR}/proj/one`)).toBe(true);
  });

  it("treats an idle session's worktree as not live", () => {
    const usage = collectWorktreeUsage([
      thread({ session: { status: "idle" } as OrchestrationThreadShell["session"] }),
    ]);
    expect(usage.liveWorktreePaths.size).toBe(0);
  });

  it("still protects a live worktree whose thread is archived", () => {
    const usage = collectWorktreeUsage([
      thread({
        archivedAt: "2026-01-01T00:00:00.000Z",
        session: { status: "ready" } as OrchestrationThreadShell["session"],
      }),
    ]);
    expect(usage.liveWorktreePaths.size).toBe(1);
    expect(usage.activeThreadWorktreePaths.size).toBe(0);
  });

  it("treats a non-archived thread's worktree as active", () => {
    const usage = collectWorktreeUsage([thread({ archivedAt: null })]);
    expect(usage.activeThreadWorktreePaths.has(`${WORKTREES_DIR}/proj/one`)).toBe(true);
  });

  it("ignores threads with no worktree", () => {
    const usage = collectWorktreeUsage([thread({ worktreePath: null, archivedAt: null })]);
    expect(usage.activeThreadWorktreePaths.size).toBe(0);
  });
});

describe("serverOwnedWorktrees", () => {
  it("protects the worktree the server runs from", () => {
    const owned = serverOwnedWorktrees({
      serverCwd: `${WORKTREES_DIR}/t3code-bkmain/t3code-401beb01`,
      worktreesDir: WORKTREES_DIR,
    });
    expect([...owned]).toEqual([`${WORKTREES_DIR}/t3code-bkmain/t3code-401beb01`]);
  });

  it("protects the worktree root even when the process sits deeper", () => {
    const owned = serverOwnedWorktrees({
      serverCwd: `${WORKTREES_DIR}/t3code-bkmain/t3code-401beb01/apps/server`,
      worktreesDir: WORKTREES_DIR,
    });
    // Both the exact cwd and the worktree root above it.
    expect(owned.has(`${WORKTREES_DIR}/t3code-bkmain/t3code-401beb01`)).toBe(true);
  });

  it("protects the server's own directory even outside the worktrees root", () => {
    // Regression: the deployed servers on this host run from main checkouts
    // outside the worktrees root. Returning an empty set here left the running
    // application's directory unprotected, and a reclaim deleted its
    // node_modules.
    const owned = serverOwnedWorktrees({
      serverCwd: "/home/ubuntu/repos/t3code-expbkt3",
      worktreesDir: WORKTREES_DIR,
    });
    expect([...owned]).toEqual(["/home/ubuntu/repos/t3code-expbkt3"]);
  });

  it("does not derive a worktree root from a sibling sharing a prefix", () => {
    const owned = serverOwnedWorktrees({
      serverCwd: `${WORKTREES_DIR}-backup/proj/one`,
      worktreesDir: WORKTREES_DIR,
    });
    expect([...owned]).toEqual([`${WORKTREES_DIR}-backup/proj/one`]);
  });

  it("adds no worktree root when the path is only one level deep", () => {
    const owned = serverOwnedWorktrees({
      serverCwd: `${WORKTREES_DIR}/t3code-bkmain`,
      worktreesDir: WORKTREES_DIR,
    });
    expect([...owned]).toEqual([`${WORKTREES_DIR}/t3code-bkmain`]);
  });
});
