import type { LinearIssueStatusSummary, ThreadLinearLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergePhaseSidebarLinearStatuses,
  phaseSidebarLinearChipLabel,
  phaseSidebarLinearStatusKey,
  phaseSidebarLinearStatusRequests,
  phaseSidebarLinearTagKinds,
  pickPhaseSidebarLinearStatuses,
  resolvePhaseSidebarLinearTags,
} from "./phaseSidebarLinearTags";

const issue = (key: string): ThreadLinearLink =>
  ({ kind: "issue", url: `https://linear.app/acme/issue/${key}` }) as ThreadLinearLink;
const project: ThreadLinearLink = {
  kind: "project",
  url: "https://linear.app/acme/project/bk-sidebar-3f2a9c1d8e7b",
} as ThreadLinearLink;

const status = (identifier: string, parentIdentifier: string | null): LinearIssueStatusSummary =>
  ({
    identifier,
    url: null,
    status: "Todo",
    statusType: "unstarted",
    updatedAt: null,
    error: null,
    title: `Title of ${identifier}`,
    parentIdentifier,
  }) as LinearIssueStatusSummary;

describe("resolvePhaseSidebarLinearTags", () => {
  it("orders project, main issues, then sub-issues, keeping tag order within a kind", () => {
    const statuses = [status("ENG-2", "ENG-1"), status("ENG-1", null)];
    const tags = resolvePhaseSidebarLinearTags(
      {
        branch: null,
        linearLinks: [issue("ENG-2"), issue("ENG-1"), project, issue("ENG-3")],
      },
      statuses,
    );
    expect(tags.map((tag) => [tag.kind, tag.label])).toEqual([
      ["project", "bk sidebar"],
      ["issue", "ENG-1"],
      ["issue", "ENG-3"],
      ["sub-issue", "ENG-2"],
    ]);
    expect(tags[1]?.title).toBe("Title of ENG-1");
    expect(phaseSidebarLinearChipLabel(tags)).toBe("ENG-1 +3");
    expect(phaseSidebarLinearTagKinds(tags)).toEqual(["project", "issue", "sub-issue"]);
  });

  it("falls back to the branch issue only when the thread has no tags", () => {
    const fromBranch = resolvePhaseSidebarLinearTags(
      { branch: "linear/eng-9-fix", linearLinks: [] },
      [],
    );
    expect(fromBranch.map((tag) => tag.label)).toEqual(["ENG-9"]);
    const tagged = resolvePhaseSidebarLinearTags(
      { branch: "linear/eng-9-fix", linearLinks: [project] },
      [],
    );
    expect(phaseSidebarLinearChipLabel(tagged)).toBe("bk sidebar");
  });

  it("shows a tag once when the same link is stored twice", () => {
    const tags = resolvePhaseSidebarLinearTags(
      {
        branch: null,
        linearLinks: [
          issue("ENG-1"),
          {
            kind: "issue",
            url: "https://linear.app/acme/issue/eng-1/some-title",
          } as ThreadLinearLink,
          project,
          { kind: "project", url: `${project.url}/overview` } as ThreadLinearLink,
        ],
      },
      [],
    );
    expect(tags.map((tag) => tag.url)).toEqual([
      "https://linear.app/acme/project/bk-sidebar-3f2a9c1d8e7b",
      "https://linear.app/acme/issue/ENG-1",
    ]);
  });
});

describe("linear status identity", () => {
  it("keeps the same map and objects when a refetch changes nothing", () => {
    const first = mergePhaseSidebarLinearStatuses(new Map(), "env", [status("ENG-1", null)]);
    const same = mergePhaseSidebarLinearStatuses(first, "env", [status("ENG-1", null)]);
    expect(same).toBe(first);
    const moved = mergePhaseSidebarLinearStatuses(first, "env", [status("ENG-1", "ENG-0")]);
    expect(moved).not.toBe(first);
    expect(moved.get(phaseSidebarLinearStatusKey("env", "ENG-1"))?.parentIdentifier).toBe("ENG-0");
  });

  it("hands a row the same array until one of its own statuses changes", () => {
    const thread = { environmentId: "env", branch: null, linearLinks: [issue("ENG-1")] };
    const statuses = mergePhaseSidebarLinearStatuses(new Map(), "env", [
      status("ENG-1", null),
      status("ENG-2", null),
    ]);
    const picked = pickPhaseSidebarLinearStatuses(statuses, thread, undefined);
    expect(picked.map((entry) => entry.identifier)).toEqual(["ENG-1"]);
    const otherRowChanged = mergePhaseSidebarLinearStatuses(statuses, "env", [
      status("ENG-2", "ENG-1"),
    ]);
    expect(pickPhaseSidebarLinearStatuses(otherRowChanged, thread, picked)).toBe(picked);
    const ownChanged = mergePhaseSidebarLinearStatuses(statuses, "env", [status("ENG-1", "ENG-9")]);
    expect(pickPhaseSidebarLinearStatuses(ownChanged, thread, picked)).not.toBe(picked);
  });
});

describe("phaseSidebarLinearStatusRequests", () => {
  it("batches every issue key once per environment and skips projects", () => {
    expect(
      phaseSidebarLinearStatusRequests([
        { environmentId: "b", branch: null, linearLinks: [issue("ENG-2"), project] },
        { environmentId: "a", branch: null, linearLinks: [issue("ENG-5"), issue("ENG-1")] },
        { environmentId: "b", branch: "linear/eng-7", linearLinks: [issue("ENG-2")] },
        { environmentId: "c", branch: null, linearLinks: [project] },
      ]),
    ).toEqual([
      { environmentId: "a", identifiers: ["ENG-1", "ENG-5"] },
      { environmentId: "b", identifiers: ["ENG-2"] },
    ]);
  });
});
