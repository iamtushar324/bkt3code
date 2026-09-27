import { describe, expect, it } from "vite-plus/test";

import { resolveAddProjectNameInput } from "./addProjectNameFlow";

describe("add project name route", () => {
  it("resolves local and clone route inputs", () => {
    expect(
      resolveAddProjectNameInput({
        kind: "local",
        environmentId: "env",
        workspaceRoot: "/work/repo",
        suggestedNickname: "repo",
      }),
    ).toEqual({
      kind: "local",
      environmentId: "env",
      workspaceRoot: "/work/repo",
      suggestedNickname: "repo",
    });

    expect(
      resolveAddProjectNameInput({
        kind: ["clone"],
        environmentId: ["env"],
        remoteUrl: "git@github.com:example/repo.git",
        destinationPath: "/work",
        repositoryTitle: "example/repo",
        suggestedNickname: "repo",
      }),
    ).toMatchObject({ kind: "clone", repositoryTitle: "example/repo" });
  });

  it("rejects incomplete or unknown route inputs", () => {
    expect(resolveAddProjectNameInput({ kind: "local", environmentId: "env" })).toBeNull();
    expect(
      resolveAddProjectNameInput({
        kind: "clone",
        environmentId: "env",
        remoteUrl: "https://example.com/repo.git",
        suggestedNickname: "repo",
      }),
    ).toBeNull();
    expect(
      resolveAddProjectNameInput({
        kind: "other",
        environmentId: "env",
        suggestedNickname: "repo",
      }),
    ).toBeNull();
  });
});
