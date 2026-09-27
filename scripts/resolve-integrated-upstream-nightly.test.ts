import { assert, describe, it } from "@effect/vitest";
import { parseSemver } from "@t3tools/shared/semver";

import { resolveIntegratedUpstreamNightly } from "./resolve-integrated-upstream-nightly.ts";

const TAG = "upstream-v0.0.39-nightly.20260905.1286";
const TAG_SHA = "09aac71563c66a4f65f6fbe701aa9596cb677767";
const INTEGRATED_SHA = "be7796d867a1e66524f19e6cfee0109c3ab447f0";

describe("resolveIntegratedUpstreamNightly", () => {
  it("preserves an exact upstream nightly tag", () => {
    assert.deepStrictEqual(
      resolveIntegratedUpstreamNightly({
        upstreamSha: TAG_SHA,
        candidates: [{ tag: TAG, commit: TAG_SHA, distance: 0 }],
      }),
      { version: "0.0.39-nightly.20260905.1286", sourceTag: TAG, exact: true },
    );
  });

  it("uses numeric nightly precedence for exact and tied ancestor tags", () => {
    const earlier = "upstream-v0.0.39-nightly.20260905.9";
    const later = "upstream-v0.0.39-nightly.20260905.10";

    assert.deepStrictEqual(
      resolveIntegratedUpstreamNightly({
        upstreamSha: TAG_SHA,
        candidates: [
          { tag: earlier, commit: TAG_SHA, distance: 0 },
          { tag: later, commit: TAG_SHA, distance: 0 },
        ],
      }),
      { version: "0.0.39-nightly.20260905.10", sourceTag: later, exact: true },
    );

    assert.deepStrictEqual(
      resolveIntegratedUpstreamNightly({
        upstreamSha: INTEGRATED_SHA,
        candidates: [
          { tag: earlier, commit: "a".repeat(40), distance: 1 },
          { tag: later, commit: "b".repeat(40), distance: 1 },
        ],
      }),
      {
        version: "0.0.39-nightly.20260905.10.upstream.gbe7796d867a1",
        sourceTag: later,
        exact: false,
      },
    );
  });

  it("marks an untagged integrated upstream SHA after its nearest nightly", () => {
    const resolution = resolveIntegratedUpstreamNightly({
      upstreamSha: INTEGRATED_SHA,
      candidates: [
        { tag: "upstream-v0.0.39-nightly.20260904.1280", commit: "a".repeat(40), distance: 8 },
        { tag: TAG, commit: TAG_SHA, distance: 5 },
      ],
    });

    assert.deepStrictEqual(resolution, {
      version: "0.0.39-nightly.20260905.1286.upstream.gbe7796d867a1",
      sourceTag: TAG,
      exact: false,
    });
    assert.exists(parseSemver(resolution.version));
  });

  it("fails closed without a nightly ancestor or with an invalid nearest tag", () => {
    assert.throws(() =>
      resolveIntegratedUpstreamNightly({ upstreamSha: INTEGRATED_SHA, candidates: [] }),
    );
    assert.throws(() =>
      resolveIntegratedUpstreamNightly({
        upstreamSha: INTEGRATED_SHA,
        candidates: [
          { tag: "upstream-v0.0.39-nightly.20260905.bad", commit: TAG_SHA, distance: 1 },
        ],
      }),
    );
  });
});
