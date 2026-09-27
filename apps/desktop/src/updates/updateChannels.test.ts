import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("updateChannels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  // T3-CUSTOM(expbkt3): BEGIN - fork-only channel coverage.
  it("routes upstream nightly versions to the nightly channel", () => {
    expect(isNightlyDesktopVersion("0.0.32-nightly.20260810.1")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.32-nightly.20260810.1")).toBe("nightly");
  });

  it("keeps an untagged integrated upstream revision on the nightly channel", () => {
    expect(isNightlyDesktopVersion("0.0.39-nightly.20260905.1286.upstream.gbe7796d867a1")).toBe(
      true,
    );
    expect(
      resolveDefaultDesktopUpdateChannel("0.0.39-nightly.20260905.1286.upstream.gbe7796d867a1"),
    ).toBe("nightly");
  });

  it("routes stable versions to latest", () => {
    expect(isNightlyDesktopVersion("0.0.32")).toBe(false);
    expect(resolveDefaultDesktopUpdateChannel("0.0.32")).toBe("latest");
  });

  // The fork's versions carry their updater channel as the first prerelease
  // identifier (0.0.32-staging-nightly.20260810.1), and this check is what
  // decides whether such a build defaults to the nightly channel at all. If it
  // stopped matching, allowPrerelease would be off, the brand channel would
  // never be applied, and every fork build would silently stop seeing updates
  // — with no error anywhere. That is the reason `-nightly.YYYYMMDD.N` is kept
  // as the suffix rather than replaced.
  it("still recognises both fork channels as nightly builds", () => {
    expect(isNightlyDesktopVersion("0.0.32-staging-nightly.20260810.1")).toBe(true);
    expect(isNightlyDesktopVersion("0.0.32-production-nightly.20260810.1")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.32-staging-nightly.20260810.1")).toBe("nightly");
    expect(resolveDefaultDesktopUpdateChannel("0.0.32-production-nightly.20260810.1")).toBe(
      "nightly",
    );
  });
  // T3-CUSTOM(expbkt3): END
});
