/**
 * T3-CUSTOM(expbkt3): Focused coverage for the Active Projects view model.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  buildActiveProjectSettingsRows,
  normalizeProjectNickname,
  suggestedProjectNickname,
  type ActiveProjectSource,
  type ActiveProjectThreadSource,
} from "./ActiveProjectsSettingsPanel.logic";

const projects: ReadonlyArray<ActiveProjectSource> = [
  {
    environmentId: "local",
    id: "alpha",
    title: "Alpha",
    workspaceRoot: "/repos/alpha",
    updatedAt: "2026-07-20T10:00:00.000Z",
  },
  {
    environmentId: "remote",
    id: "beta",
    title: "Customer Portal",
    workspaceRoot: "/srv/beta",
    updatedAt: "2026-07-21T10:00:00.000Z",
  },
];

function thread(
  overrides: Partial<ActiveProjectThreadSource> &
    Pick<ActiveProjectThreadSource, "id" | "projectId">,
): ActiveProjectThreadSource {
  return {
    environmentId: "local",
    updatedAt: "2026-07-22T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    latestTurn: null,
    session: null,
    execution: null,
    ...overrides,
  };
}

describe("ActiveProjectsSettingsPanel logic", () => {
  it("derives nicknames from POSIX and Windows workspace roots", () => {
    expect(suggestedProjectNickname("/repos/t3-code/")).toBe("t3-code");
    expect(suggestedProjectNickname("C:\\work\\customer-portal\\")).toBe("customer-portal");
    expect(suggestedProjectNickname("   ")).toBe("");
  });

  it("trims nicknames and rejects empty values", () => {
    expect(normalizeProjectNickname("  Control center  ")).toBe("Control center");
    expect(normalizeProjectNickname(" \n ")).toBeNull();
  });

  it("summarizes sessions and prioritizes projects needing attention", () => {
    const rows = buildActiveProjectSettingsRows({
      projects,
      threads: [
        thread({ id: "alpha-running", projectId: "alpha", session: { status: "running" } }),
        thread({
          id: "beta-review",
          projectId: "beta",
          environmentId: "remote",
          hasActionableProposedPlan: true,
          updatedAt: "2026-07-23T10:00:00.000Z",
        }),
      ],
      environmentLabelById: new Map([
        ["local", "This device"],
        ["remote", "Production relay"],
      ]),
      query: "",
    });

    expect(rows.map((row) => row.project.id)).toEqual(["beta", "alpha"]);
    expect(rows[0]).toMatchObject({
      environmentLabel: "Production relay",
      attentionCount: 1,
      runningCount: 0,
      sessionCount: 1,
    });
    expect(rows[1]).toMatchObject({
      attentionCount: 0,
      runningCount: 1,
      sessionCount: 1,
    });
  });

  it("searches nickname, path, and environment label", () => {
    const environmentLabelById = new Map([
      ["local", "This device"],
      ["remote", "Production relay"],
    ]);

    expect(
      buildActiveProjectSettingsRows({
        projects,
        threads: [],
        environmentLabelById,
        query: "customer",
      }).map((row) => row.project.id),
    ).toEqual(["beta"]);
    expect(
      buildActiveProjectSettingsRows({
        projects,
        threads: [],
        environmentLabelById,
        query: "production",
      }).map((row) => row.project.id),
    ).toEqual(["beta"]);
    expect(
      buildActiveProjectSettingsRows({
        projects,
        threads: [],
        environmentLabelById,
        query: "/repos",
      }).map((row) => row.project.id),
    ).toEqual(["alpha"]);
  });
});
