import { describe, expect, it } from "@effect/vitest";
import { THREAD_LINEAR_LINKS_MAX } from "@t3tools/contracts";

import {
  applyLinearLinkChanges,
  linearIssueFromBranch,
  parseLinearIssueUrl,
  parseLinearLinkUrl,
  parseLinearProjectUrl,
  threadLinearLinks,
} from "./linearIssue.ts";

describe("parseLinearIssueUrl", () => {
  it("canonicalises an issue URL, dropping the slug and query", () => {
    expect(parseLinearIssueUrl("https://linear.app/beknown/issue/tec-1301/some-slug?x=1")).toEqual({
      identifier: "TEC-1301",
      url: "https://linear.app/beknown/issue/TEC-1301",
    });
  });

  it("accepts an issue URL with no slug", () => {
    expect(parseLinearIssueUrl("https://linear.app/acme/issue/ENG-42")?.identifier).toBe("ENG-42");
  });

  it("refuses anything that is not a linear.app issue", () => {
    // The stored URL is handed to openExternal on the sidebar row, so a string
    // that only looks like a tag must never reach the projection.
    for (const candidate of [
      "https://linear.app/beknown/team/TEC/all",
      "https://linear.app.evil.test/beknown/issue/TEC-1",
      "http://linear.app/beknown/issue/TEC-1",
      "javascript:alert(1)",
      "TEC-1301",
      "",
      null,
      undefined,
    ]) {
      expect(parseLinearIssueUrl(candidate)).toBeNull();
    }
  });
});

describe("linearIssueFromBranch", () => {
  it("reads the issue a linear branch names", () => {
    expect(linearIssueFromBranch("linear/tec-1301-thread-names")).toEqual({
      identifier: "TEC-1301",
      url: "https://linear.app/beknown/issue/TEC-1301",
    });
    expect(linearIssueFromBranch("linear/ENG-7")?.identifier).toBe("ENG-7");
  });

  it("ignores a branch that does not name one", () => {
    expect(linearIssueFromBranch("t3code/nagpur")).toBeNull();
    expect(linearIssueFromBranch(null)).toBeNull();
  });
});

// T3-CUSTOM(expbkt3): several Linear tags on one session.
const ISSUE_42 = "https://linear.app/acme/issue/ENG-42";
const ISSUE_43 = "https://linear.app/acme/issue/ENG-43";
const PROJECT = "https://linear.app/acme/project/checkout-revamp-0a1b2c3d4e5f";

describe("parseLinearProjectUrl", () => {
  it("canonicalises a project URL and reads its name from the slug", () => {
    expect(
      parseLinearProjectUrl(
        "https://linear.app/acme/project/Checkout-Revamp-0A1B2C3D4E5F/overview?tab=1",
      ),
    ).toEqual({
      kind: "project",
      url: PROJECT,
      identifier: "checkout-revamp-0a1b2c3d4e5f",
      label: "checkout revamp",
    });
  });

  it("refuses anything that is not a linear.app project", () => {
    for (const candidate of [
      ISSUE_42,
      "https://linear.app/acme/team/ENG/projects",
      "https://linear.app.evil.test/acme/project/x-0a1b2c3d4e5f",
      "",
      null,
    ]) {
      expect(parseLinearProjectUrl(candidate)).toBeNull();
    }
  });
});

describe("parseLinearLinkUrl", () => {
  it("tells an issue from a project", () => {
    expect(parseLinearLinkUrl(`${ISSUE_42}/some-slug`)).toEqual({
      kind: "issue",
      url: ISSUE_42,
      identifier: "ENG-42",
      label: "ENG-42",
    });
    expect(parseLinearLinkUrl(PROJECT)?.kind).toBe("project");
    expect(parseLinearLinkUrl("ENG-42")).toBeNull();
  });
});

describe("threadLinearLinks", () => {
  it("reads a pre-multi-tag thread's single tag as a one-item list", () => {
    expect(threadLinearLinks({ linearIssueUrl: ISSUE_42 })).toEqual([
      { url: ISSUE_42, kind: "issue" },
    ]);
    expect(threadLinearLinks({ linearIssueUrl: null })).toEqual([]);
  });

  it("prefers the stored list, even an empty one", () => {
    expect(threadLinearLinks({ linearLinks: [], linearIssueUrl: ISSUE_42 })).toEqual([]);
  });
});

describe("applyLinearLinkChanges", () => {
  it("adds to the legacy single tag and mirrors the first issue", () => {
    const current = threadLinearLinks({ linearIssueUrl: ISSUE_42 });
    expect(
      applyLinearLinkChanges(current, {
        linearLinksAdd: [
          { url: PROJECT, kind: "project" },
          { url: ISSUE_43, kind: "issue" },
        ],
      }),
    ).toEqual({
      linearLinks: [
        { url: ISSUE_42, kind: "issue" },
        { url: PROJECT, kind: "project" },
        { url: ISSUE_43, kind: "issue" },
      ],
      linearIssueUrl: ISSUE_42,
    });
  });

  it("keeps an already-linked tag in place, matching by canonical URL", () => {
    const current = [
      { url: ISSUE_42, kind: "issue" as const },
      { url: PROJECT, kind: "project" as const },
    ];
    expect(
      applyLinearLinkChanges(current, {
        linearLinksAdd: [{ url: "https://linear.app/acme/issue/eng-42/slug", kind: "issue" }],
      }).linearLinks,
    ).toEqual(current);
  });

  it("removes by any spelling of the URL and moves the mirror to the next issue", () => {
    const current = [
      { url: ISSUE_42, kind: "issue" as const },
      { url: ISSUE_43, kind: "issue" as const },
    ];
    expect(
      applyLinearLinkChanges(current, {
        linearLinksRemove: ["https://linear.app/acme/issue/eng-42?x=1"],
      }),
    ).toEqual({ linearLinks: [{ url: ISSUE_43, kind: "issue" }], linearIssueUrl: ISSUE_43 });
  });

  it("clears every tag on a null single tag and has no mirror without an issue", () => {
    const current = [
      { url: ISSUE_42, kind: "issue" as const },
      { url: PROJECT, kind: "project" as const },
    ];
    expect(applyLinearLinkChanges(current, { linearIssueUrl: null })).toEqual({
      linearLinks: [],
      linearIssueUrl: null,
    });
    expect(
      applyLinearLinkChanges([], { linearLinksAdd: [{ url: PROJECT, kind: "project" }] }),
    ).toEqual({ linearLinks: [{ url: PROJECT, kind: "project" }], linearIssueUrl: null });
  });

  it("moves a single-tag URL to the front so the mirror follows it", () => {
    const current = [
      { url: PROJECT, kind: "project" as const },
      { url: ISSUE_42, kind: "issue" as const },
      { url: ISSUE_43, kind: "issue" as const },
    ];
    expect(applyLinearLinkChanges(current, { linearIssueUrl: `${ISSUE_43}/slug` })).toEqual({
      linearLinks: [
        { url: ISSUE_43, kind: "issue" },
        { url: PROJECT, kind: "project" },
        { url: ISSUE_42, kind: "issue" },
      ],
      linearIssueUrl: ISSUE_43,
    });
  });

  it(`holds at most ${THREAD_LINEAR_LINKS_MAX} tags`, () => {
    const full = Array.from({ length: THREAD_LINEAR_LINKS_MAX }, (_, index) => ({
      url: `https://linear.app/acme/issue/ENG-${1000 + index}`,
      kind: "issue" as const,
    }));
    // Additions past the cap are ignored.
    expect(
      applyLinearLinkChanges(full, { linearLinksAdd: [{ url: PROJECT, kind: "project" }] })
        .linearLinks,
    ).toEqual(full);
    // The single-tag field still lands, at the front; the last tag gives way.
    const replaced = applyLinearLinkChanges(full, { linearIssueUrl: ISSUE_42 });
    expect(replaced.linearLinks).toHaveLength(THREAD_LINEAR_LINKS_MAX);
    expect(replaced.linearLinks[0]).toEqual({ url: ISSUE_42, kind: "issue" });
    expect(replaced.linearIssueUrl).toBe(ISSUE_42);
    // A removal in the same change makes room for an addition.
    expect(
      applyLinearLinkChanges(full, {
        linearLinksRemove: ["https://linear.app/acme/issue/ENG-1000"],
        linearLinksAdd: [{ url: PROJECT, kind: "project" }],
      }).linearLinks.at(-1),
    ).toEqual({ url: PROJECT, kind: "project" });
  });

  it("adds a single-tag URL and ignores additions that are not Linear URLs", () => {
    expect(
      applyLinearLinkChanges([], {
        linearIssueUrl: `${ISSUE_43}/slug`,
        linearLinksAdd: [{ url: "https://example.com/x", kind: "issue" }],
      }).linearLinks,
    ).toEqual([{ url: ISSUE_43, kind: "issue" }]);
  });
});
