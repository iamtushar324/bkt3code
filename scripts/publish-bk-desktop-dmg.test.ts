import { describe, expect, it } from "vite-plus/test";

import {
  fingerprintDesignatedRequirement,
  findPreviousChannelTag,
  summarizeCommitSubjects,
} from "./publish-bk-desktop-dmg.ts";

// A real Apple-issued requirement embeds the developer's email and Team ID in
// the certificate common name. This repository is public, so the raw string must
// never reach a release body.
const APPLE_REQUIREMENT =
  'identifier "work.beknown.bkt3code" and anchor apple generic and certificate ' +
  'leaf[subject.CN] = "Apple Development: someone@example.com (ABCDE12345)" and ' +
  "certificate 1[field.1.2.840.113635.100.6.2.1] /* exists */";

describe("fingerprintDesignatedRequirement", () => {
  it("publishes no personally identifying data", () => {
    const fingerprint = fingerprintDesignatedRequirement(APPLE_REQUIREMENT);
    expect(fingerprint).not.toContain("someone@example.com");
    expect(fingerprint).not.toContain("ABCDE12345");
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is stable across builds of the same identity", () => {
    // codesign appends `Executable=<temp path>`, which differs on every run —
    // and on CI is the runner's temp dir. Including it would both leak that path
    // and make one identity look like two.
    const first = `${APPLE_REQUIREMENT} Executable=/private/var/folders/aa/T/x1/BK T3 Code.app`;
    const second = `${APPLE_REQUIREMENT} Executable=/private/var/folders/zz/T/q9/BK T3 Code.app`;
    expect(fingerprintDesignatedRequirement(first)).toBe(fingerprintDesignatedRequirement(second));
    expect(fingerprintDesignatedRequirement(first)).toBe(
      fingerprintDesignatedRequirement(APPLE_REQUIREMENT),
    );
  });

  it("changes when the signing identity changes", () => {
    // The whole point: a rotated certificate breaks auto-update for every
    // install, so the fingerprint has to make that visible.
    const rotated = APPLE_REQUIREMENT.replace("ABCDE12345", "ZZZZZ99999");
    expect(fingerprintDesignatedRequirement(rotated)).not.toBe(
      fingerprintDesignatedRequirement(APPLE_REQUIREMENT),
    );
  });
});

describe("summarizeCommitSubjects", () => {
  it("keeps the subject line and drops the body", () => {
    expect(
      summarizeCommitSubjects(["fix(web): stop the panel flickering\n\nLong explanation."]),
    ).toEqual(["fix(web): stop the panel flickering"]);
  });

  it("drops merge commits, which would otherwise list every change twice", () => {
    expect(
      summarizeCommitSubjects([
        "Merge pull request #118 from beknown-work/t3code/plan-comment-box",
        "fix(planreview): dock the comment box under the plan",
      ]),
    ).toEqual(["fix(planreview): dock the comment box under the plan"]);
  });

  it("collapses duplicate subjects from a rebase or cherry-pick", () => {
    expect(summarizeCommitSubjects(["fix: same", "fix: same", "fix: other"])).toEqual([
      "fix: same",
      "fix: other",
    ]);
  });

  it("summarises the tail instead of printing a wall of commits", () => {
    const many = Array.from({ length: 20 }, (_, index) => `fix: change ${index}`);
    const summarized = summarizeCommitSubjects(many, 15);

    expect(summarized).toHaveLength(16);
    expect(summarized[15]).toBe("…and 5 more commits.");
  });

  it("returns nothing when there is nothing to say", () => {
    expect(summarizeCommitSubjects([])).toEqual([]);
    expect(summarizeCommitSubjects(["Merge branch 'bkmain' into expbkmain", "  ", ""])).toEqual([]);
  });
});

/**
 * These tags are the real shapes, because the first version of this lookup keyed
 * on the brand's `updateChannel` — already `staging-nightly` — and searched for
 * `-staging-nightly-nightly.`. It matched nothing, so a release shipped with an
 * empty change list and nothing failed to say so.
 */
describe("findPreviousChannelTag", () => {
  const TAGS = [
    "v0.0.34-staging-nightly.20260819.1",
    "v0.0.34-production-nightly.20260818.2",
    "v0.0.34-staging-nightly.20260818.6",
    "v0.0.34-production-nightly.20260817.1",
  ];

  it("finds the newest tag of the requested channel", () => {
    expect(findPreviousChannelTag(TAGS, "staging")).toBe("v0.0.34-staging-nightly.20260819.1");
    expect(findPreviousChannelTag(TAGS, "production")).toBe(
      "v0.0.34-production-nightly.20260818.2",
    );
  });

  it("never returns the other channel's build", () => {
    expect(findPreviousChannelTag(["v0.0.34-production-nightly.20260818.2"], "staging")).toBe(
      undefined,
    );
  });

  it("returns undefined for the very first build of a channel", () => {
    expect(findPreviousChannelTag([], "production")).toBe(undefined);
  });
});
