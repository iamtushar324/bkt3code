import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { filterPhaseSidebarRowsForHost } from "./phaseSidebarHostFilters";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const alpha = ProjectId.make("alpha");
const beta = ProjectId.make("beta");

function row(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly id: string;
  readonly title: string;
  readonly repositoryLabel: string;
}): PhaseSidebarRow {
  return {
    thread: {
      environmentId: input.environmentId,
      projectId: input.projectId,
      id: ThreadId.make(input.id),
      title: input.title,
    },
    repositoryLabel: input.repositoryLabel,
  } as PhaseSidebarRow;
}

const rows = [
  row({
    environmentId: local,
    projectId: alpha,
    id: "one",
    title: "Fix sidebar",
    repositoryLabel: "T3",
  }),
  row({
    environmentId: local,
    projectId: beta,
    id: "two",
    title: "Write docs",
    repositoryLabel: "Docs",
  }),
  row({
    environmentId: remote,
    projectId: alpha,
    id: "three",
    title: "Release",
    repositoryLabel: "T3",
  }),
];

describe("filterPhaseSidebarRowsForHost", () => {
  it("applies the selected environment and project scope before lifecycle grouping", () => {
    expect(
      filterPhaseSidebarRowsForHost(rows, {
        selectedEnvironmentId: local,
        selectedProjectKeys: new Set([scopedProjectKey(local, alpha)]),
        searchQuery: "",
        matchedThreadKeys: new Set(),
      }).map((item) => item.thread.id),
    ).toEqual([ThreadId.make("one")]);
  });

  it("keeps Home title, project, and message search semantics aligned", () => {
    expect(
      filterPhaseSidebarRowsForHost(rows, {
        selectedEnvironmentId: null,
        selectedProjectKeys: null,
        searchQuery: "t3",
        matchedThreadKeys: new Set(),
      }).map((item) => item.thread.id),
    ).toEqual([ThreadId.make("one"), ThreadId.make("three")]);

    expect(
      filterPhaseSidebarRowsForHost(rows, {
        selectedEnvironmentId: local,
        selectedProjectKeys: null,
        searchQuery: "unmatched",
        matchedThreadKeys: new Set([JSON.stringify([local, ThreadId.make("two")])]),
      }).map((item) => item.thread.id),
    ).toEqual([ThreadId.make("two")]);
  });
});
