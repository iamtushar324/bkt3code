import { describe, expect, it } from "@effect/vitest";

import { linearIssueFromBranch, parseLinearIssueUrl } from "./linearIssue.ts";

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
