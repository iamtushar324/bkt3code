// T3-CUSTOM(expbkt3): protect the fork badge data through upstream's GraphQL shape.
import { expect, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { decodeGitHubPullRequestListJson } from "./gitHubPullRequests.ts";
import { withGitHubHeadReadiness } from "./gitHubHeadReadiness.expbkt3.ts";

const decodeGitHubPullRequestEntries = (entries: ReadonlyArray<unknown>) =>
  Result.getOrThrow(decodeGitHubPullRequestListJson(JSON.stringify(entries)));

const pullRequest = {
  number: 7,
  title: "Fork PR",
  url: "https://github.com/acme/web/pull/7",
  baseRefName: "main",
  headRefName: "main",
  state: "OPEN",
  isCrossRepository: true,
  headRepository: { nameWithOwner: "contributor/web" },
  headRepositoryOwner: { login: "contributor" },
};

it.each([
  ["SUCCESS", "pass"],
  ["FAILURE", "fail"],
  ["ERROR", "fail"],
  ["PENDING", "pending"],
  ["EXPECTED", "pending"],
])(
  "maps the native %s head verdict into the %s badge without losing fork identity",
  (state, checksStatus) => {
    const [decoded] = decodeGitHubPullRequestEntries([
      withGitHubHeadReadiness({
        ...pullRequest,
        commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] },
      }),
    ]);
    expect(decoded).toMatchObject({
      number: 7,
      headRefName: "main",
      checksStatus,
      isCrossRepository: true,
      headRepositoryNameWithOwner: "contributor/web",
      headRepositoryOwnerLogin: "contributor",
    });
  },
);

it("does not lose a PR when the head has no checks or an older reply has no commit selection", () => {
  const [withoutChecks, olderReply] = decodeGitHubPullRequestEntries([
    withGitHubHeadReadiness({
      ...pullRequest,
      commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    }),
    withGitHubHeadReadiness(pullRequest),
  ]);
  expect(withoutChecks).toMatchObject({ number: 7, checksStatus: "pass" });
  expect(olderReply).toMatchObject({ number: 7, headRepositoryNameWithOwner: "contributor/web" });
  expect(olderReply?.checksStatus).toBeUndefined();
});
