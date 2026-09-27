/**
 * T3-CUSTOM(expbkt3): Coverage for the archived-worktree reclaim gates.
 *
 * These gates are the only thing standing between the feature and deleting
 * someone's running worktree, so each one is asserted directly rather than
 * through the service that calls them.
 */
import { describe, expect, it } from "@effect/vitest";

import {
  evaluateReclaimEligibility,
  isManagedWorktree,
  isPastRetention,
  isWorktreeProtected,
  normalizeWorktreePath,
  type ReclaimEligibilityInput,
} from "./reclaimEligibility.ts";

const NOW_MS = Date.parse("2026-08-07T00:00:00.000Z");
const ARCHIVED_LONG_AGO = "2026-01-01T00:00:00.000Z";
const WORKTREES_DIR = "/home/ubuntu/.t3/dev/worktrees";
const WORKTREE = `${WORKTREES_DIR}/proj/feature`;

const CLEAN_GIT = {
  hasUncommittedChanges: false,
  hasUntrackedFiles: false,
  hasUnpushedCommits: false,
};

const input = (overrides: Partial<ReclaimEligibilityInput> = {}): ReclaimEligibilityInput => ({
  thread: { threadId: "thread_1", worktreePath: WORKTREE, archivedAt: ARCHIVED_LONG_AGO },
  mode: "slim",
  git: CLEAN_GIT,
  liveWorktreePaths: new Set(),
  activeThreadWorktreePaths: new Set(),
  minArchivedDays: 0,
  nowMs: NOW_MS,
  force: false,
  worktreesDir: WORKTREES_DIR,
  ...overrides,
});

describe("evaluateReclaimEligibility", () => {
  it("allows a slim of a clean, solely-owned, archived worktree", () => {
    expect(evaluateReclaimEligibility(input())).toEqual({ eligible: true, blockedReason: null });
  });

  it("refuses a thread that is not archived", () => {
    const result = evaluateReclaimEligibility(
      input({ thread: { threadId: "thread_1", worktreePath: WORKTREE, archivedAt: null } }),
    );
    expect(result.blockedReason).toBe("not-archived");
  });

  it("refuses a thread with no worktree", () => {
    const result = evaluateReclaimEligibility(
      input({
        thread: { threadId: "thread_1", worktreePath: null, archivedAt: ARCHIVED_LONG_AGO },
      }),
    );
    expect(result.blockedReason).toBe("no-worktree");
  });

  it("refuses a worktree a session is running out of", () => {
    const result = evaluateReclaimEligibility(input({ liveWorktreePaths: new Set([WORKTREE]) }));
    expect(result.blockedReason).toBe("worktree-live");
  });

  it("refuses a worktree still referenced by an active thread", () => {
    const result = evaluateReclaimEligibility(
      input({ activeThreadWorktreePaths: new Set([WORKTREE]) }),
    );
    expect(result.blockedReason).toBe("worktree-shared");
  });

  it("keeps the live and shared gates un-forceable", () => {
    expect(
      evaluateReclaimEligibility(
        input({ force: true, mode: "remove", liveWorktreePaths: new Set([WORKTREE]) }),
      ).blockedReason,
    ).toBe("worktree-live");
    expect(
      evaluateReclaimEligibility(
        input({ force: true, mode: "remove", activeThreadWorktreePaths: new Set([WORKTREE]) }),
      ).blockedReason,
    ).toBe("worktree-shared");
  });

  it("reports the live gate ahead of a dirty tree", () => {
    const result = evaluateReclaimEligibility(
      input({
        mode: "remove",
        liveWorktreePaths: new Set([WORKTREE]),
        git: { ...CLEAN_GIT, hasUncommittedChanges: true },
      }),
    );
    expect(result.blockedReason).toBe("worktree-live");
  });

  it("holds a session inside the retention window", () => {
    const result = evaluateReclaimEligibility(
      input({
        minArchivedDays: 14,
        thread: {
          threadId: "thread_1",
          worktreePath: WORKTREE,
          archivedAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    );
    expect(result.blockedReason).toBe("retention-window");
  });

  it("releases a session once the retention window has passed", () => {
    expect(evaluateReclaimEligibility(input({ minArchivedDays: 14 })).eligible).toBe(true);
  });

  describe("mode: remove", () => {
    it("refuses uncommitted changes", () => {
      const result = evaluateReclaimEligibility(
        input({ mode: "remove", git: { ...CLEAN_GIT, hasUncommittedChanges: true } }),
      );
      expect(result.blockedReason).toBe("dirty-worktree");
    });

    it("refuses untracked files", () => {
      const result = evaluateReclaimEligibility(
        input({ mode: "remove", git: { ...CLEAN_GIT, hasUntrackedFiles: true } }),
      );
      expect(result.blockedReason).toBe("dirty-worktree");
    });

    it("refuses unpushed commits", () => {
      const result = evaluateReclaimEligibility(
        input({ mode: "remove", git: { ...CLEAN_GIT, hasUnpushedCommits: true } }),
      );
      expect(result.blockedReason).toBe("unpushed-commits");
    });

    it("allows those to be forced", () => {
      const result = evaluateReclaimEligibility(
        input({
          mode: "remove",
          force: true,
          git: { hasUncommittedChanges: true, hasUntrackedFiles: true, hasUnpushedCommits: true },
        }),
      );
      expect(result.eligible).toBe(true);
    });

    it("refuses when git facts are unavailable", () => {
      const result = evaluateReclaimEligibility(input({ mode: "remove", git: null }));
      expect(result.blockedReason).toBe("no-worktree");
    });
  });

  describe("mode: slim", () => {
    it("ignores a dirty tree, because it only deletes ignored directories", () => {
      const result = evaluateReclaimEligibility(
        input({
          git: { hasUncommittedChanges: true, hasUntrackedFiles: true, hasUnpushedCommits: true },
        }),
      );
      expect(result.eligible).toBe(true);
    });
  });
});

describe("isPastRetention", () => {
  it("treats a zero window as always past", () => {
    expect(isPastRetention({ archivedAt: null, minArchivedDays: 0, nowMs: NOW_MS })).toBe(true);
  });

  it("fails closed on a missing timestamp", () => {
    expect(isPastRetention({ archivedAt: null, minArchivedDays: 1, nowMs: NOW_MS })).toBe(false);
  });

  it("fails closed on an unparseable timestamp", () => {
    expect(isPastRetention({ archivedAt: "not a date", minArchivedDays: 1, nowMs: NOW_MS })).toBe(
      false,
    );
  });

  it("is inclusive at the boundary", () => {
    // Exactly 14 days before NOW_MS (2026-08-07T00:00:00Z).
    const archivedAt = "2026-07-24T00:00:00.000Z";
    expect(isPastRetention({ archivedAt, minArchivedDays: 14, nowMs: NOW_MS })).toBe(true);
  });

  it("holds one millisecond short of the boundary", () => {
    const archivedAt = "2026-07-24T00:00:00.001Z";
    expect(isPastRetention({ archivedAt, minArchivedDays: 14, nowMs: NOW_MS })).toBe(false);
  });
});

describe("normalizeWorktreePath", () => {
  it("maps blank and whitespace-only paths to null", () => {
    expect(normalizeWorktreePath(null)).toBeNull();
    expect(normalizeWorktreePath("")).toBeNull();
    expect(normalizeWorktreePath("   ")).toBeNull();
  });

  it("trims so both tiers compare the same string", () => {
    expect(normalizeWorktreePath(`  ${WORKTREE}  `)).toBe(WORKTREE);
  });
});

describe("per-mode reporting the scan relies on", () => {
  // The panel reports `blockedReason` (slim) and `removeBlockedReason` (remove)
  // separately, and its force affordance keys off the difference. These assert
  // the two evaluations really do diverge only where they should.
  it("lets a dirty worktree slim while refusing to remove it", () => {
    const dirty = { ...CLEAN_GIT, hasUncommittedChanges: true };
    expect(
      evaluateReclaimEligibility(input({ mode: "slim", git: dirty })).blockedReason,
    ).toBeNull();
    expect(evaluateReclaimEligibility(input({ mode: "remove", git: dirty })).blockedReason).toBe(
      "dirty-worktree",
    );
  });

  it("reports a mode-independent gate identically for both modes", () => {
    for (const overrides of [
      { liveWorktreePaths: new Set([WORKTREE]) },
      { activeThreadWorktreePaths: new Set([WORKTREE]) },
    ]) {
      const slim = evaluateReclaimEligibility(input({ ...overrides, mode: "slim" }));
      const remove = evaluateReclaimEligibility(input({ ...overrides, mode: "remove" }));
      expect(slim.blockedReason).toBe(remove.blockedReason);
      expect(slim.blockedReason).not.toBeNull();
    }
  });

  it("only ever reports a forceable reason for the remove mode", () => {
    const bad = { hasUncommittedChanges: true, hasUntrackedFiles: true, hasUnpushedCommits: true };
    expect(evaluateReclaimEligibility(input({ mode: "slim", git: bad })).blockedReason).toBeNull();
  });
});

describe("protecting worktrees used by non-archived sessions", () => {
  const ACTIVE = `${WORKTREES_DIR}/proj/active`;

  it("refuses a worktree an active session uses, whatever the mode", () => {
    for (const mode of ["slim", "remove"] as const) {
      const result = evaluateReclaimEligibility(
        input({
          mode,
          thread: { threadId: "t", worktreePath: ACTIVE, archivedAt: ARCHIVED_LONG_AGO },
          activeThreadWorktreePaths: new Set([ACTIVE]),
        }),
      );
      expect(result.blockedReason).toBe("worktree-shared");
    }
  });

  it("matches despite a trailing slash on either side", () => {
    expect(
      evaluateReclaimEligibility(
        input({
          thread: { threadId: "t", worktreePath: `${ACTIVE}/`, archivedAt: ARCHIVED_LONG_AGO },
          activeThreadWorktreePaths: new Set([ACTIVE]),
        }),
      ).blockedReason,
    ).toBe("worktree-shared");

    expect(
      evaluateReclaimEligibility(
        input({
          thread: { threadId: "t", worktreePath: ACTIVE, archivedAt: ARCHIVED_LONG_AGO },
          activeThreadWorktreePaths: new Set([`${ACTIVE}/`]),
        }),
      ).blockedReason,
    ).toBe("worktree-shared");
  });

  it("matches despite duplicated separators", () => {
    expect(
      evaluateReclaimEligibility(
        input({
          thread: {
            threadId: "t",
            worktreePath: "/home/ubuntu//.t3/dev/worktrees/proj/active",
            archivedAt: ARCHIVED_LONG_AGO,
          },
          activeThreadWorktreePaths: new Set([ACTIVE]),
        }),
      ).blockedReason,
    ).toBe("worktree-shared");
  });

  it("refuses a parent whose removal would take an active worktree with it", () => {
    // Must itself be a managed worktree, or the stricter gate fires first.
    const parent = `${WORKTREES_DIR}/proj/wt`;
    const result = evaluateReclaimEligibility(
      input({
        thread: { threadId: "t", worktreePath: parent, archivedAt: ARCHIVED_LONG_AGO },
        activeThreadWorktreePaths: new Set([`${parent}/nested`]),
      }),
    );
    expect(result.blockedReason).toBe("worktree-shared");
  });

  it("refuses a subdirectory of an active worktree", () => {
    const result = evaluateReclaimEligibility(
      input({
        thread: { threadId: "t", worktreePath: `${ACTIVE}/apps`, archivedAt: ARCHIVED_LONG_AGO },
        activeThreadWorktreePaths: new Set([ACTIVE]),
      }),
    );
    expect(result.blockedReason).toBe("worktree-shared");
  });

  it("does not mistake a sibling sharing a name prefix for the same worktree", () => {
    const result = evaluateReclaimEligibility(
      input({
        thread: { threadId: "t", worktreePath: `${ACTIVE}-backup`, archivedAt: ARCHIVED_LONG_AGO },
        activeThreadWorktreePaths: new Set([ACTIVE]),
      }),
    );
    expect(result.eligible).toBe(true);
  });

  it("cannot be forced past", () => {
    const result = evaluateReclaimEligibility(
      input({
        mode: "remove",
        force: true,
        thread: { threadId: "t", worktreePath: ACTIVE, archivedAt: ARCHIVED_LONG_AGO },
        activeThreadWorktreePaths: new Set([ACTIVE]),
      }),
    );
    expect(result.blockedReason).toBe("worktree-shared");
  });
});

describe("isWorktreeProtected", () => {
  it("is false when nothing is protected", () => {
    expect(isWorktreeProtected("/w/a", new Set())).toBe(false);
  });

  it("ignores blank entries in the protected set", () => {
    expect(isWorktreeProtected("/w/a", new Set(["", "   "]))).toBe(false);
  });
});

describe("only T3-provisioned worktrees may be reclaimed", () => {
  // Regression: a thread created in non-worktree mode carries the project's
  // workspace root as its worktreePath. On the deployment host that is the
  // directory a running server was started from, and slimming it deleted the
  // live application's node_modules. Nothing else protected it, because
  // `serverOwnedWorktrees` only guarded paths beneath the worktrees root.
  const DEPLOY_CHECKOUT = "/home/ubuntu/repos/t3code-expbkt3";

  it("refuses a main checkout outside the worktrees root", () => {
    for (const mode of ["slim", "remove"] as const) {
      const result = evaluateReclaimEligibility(
        input({
          mode,
          thread: { threadId: "t", worktreePath: DEPLOY_CHECKOUT, archivedAt: ARCHIVED_LONG_AGO },
        }),
      );
      expect(result.blockedReason).toBe("not-a-managed-worktree");
    }
  });

  it("cannot be forced past", () => {
    const result = evaluateReclaimEligibility(
      input({
        mode: "remove",
        force: true,
        thread: { threadId: "t", worktreePath: DEPLOY_CHECKOUT, archivedAt: ARCHIVED_LONG_AGO },
      }),
    );
    expect(result.blockedReason).toBe("not-a-managed-worktree");
  });

  it("refuses the worktrees root itself and a bare project directory", () => {
    for (const worktreePath of [WORKTREES_DIR, `${WORKTREES_DIR}/proj`]) {
      const result = evaluateReclaimEligibility(
        input({ thread: { threadId: "t", worktreePath, archivedAt: ARCHIVED_LONG_AGO } }),
      );
      expect(result.blockedReason).toBe("not-a-managed-worktree");
    }
  });

  it("still allows a genuine provisioned worktree", () => {
    expect(evaluateReclaimEligibility(input()).eligible).toBe(true);
  });

  it("is checked before the gates that depend on git", () => {
    // Git facts are unavailable for a path we should not have looked at.
    const result = evaluateReclaimEligibility(
      input({
        mode: "remove",
        git: null,
        thread: { threadId: "t", worktreePath: DEPLOY_CHECKOUT, archivedAt: ARCHIVED_LONG_AGO },
      }),
    );
    expect(result.blockedReason).toBe("not-a-managed-worktree");
  });
});

describe("isManagedWorktree", () => {
  it("accepts <root>/<project>/<worktree>", () => {
    expect(isManagedWorktree(`${WORKTREES_DIR}/proj/wt`, WORKTREES_DIR)).toBe(true);
  });

  it("accepts a deeper path inside a worktree", () => {
    expect(isManagedWorktree(`${WORKTREES_DIR}/proj/wt/apps`, WORKTREES_DIR)).toBe(true);
  });

  it("rejects the root, a bare project, and anything outside", () => {
    expect(isManagedWorktree(WORKTREES_DIR, WORKTREES_DIR)).toBe(false);
    expect(isManagedWorktree(`${WORKTREES_DIR}/proj`, WORKTREES_DIR)).toBe(false);
    expect(isManagedWorktree("/home/ubuntu/repos/t3code", WORKTREES_DIR)).toBe(false);
  });

  it("is not fooled by a sibling root sharing a prefix", () => {
    expect(isManagedWorktree(`${WORKTREES_DIR}-backup/proj/wt`, WORKTREES_DIR)).toBe(false);
  });

  it("tolerates trailing slashes on either side", () => {
    expect(isManagedWorktree(`${WORKTREES_DIR}/proj/wt/`, `${WORKTREES_DIR}/`)).toBe(true);
  });
});
