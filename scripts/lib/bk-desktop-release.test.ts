import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  compareNightlyVersions,
  composeNightlyVersion,
  formatBuildDate,
  isNightlyReleaseAsset,
  isReleaseWorkflowSafeTag,
  parseNightlyVersion,
  resolveNewestNightlyVersion,
  resolveNextCounter,
  tagFromVersion,
  updateChannelForVariant,
  updateManifestFileName,
  versionFromTag,
} from "./bk-desktop-release.ts";

describe("bk-desktop-release versioning", () => {
  it("formats the build date in UTC", () => {
    expect(formatBuildDate(DateTime.makeUnsafe("2026-08-10T23:59:59Z"))).toBe("20260810");
    // A local-time formatter would roll these to a neighbouring day depending on
    // the machine's offset, which would let the ordering key move backwards.
    expect(formatBuildDate(DateTime.makeUnsafe("2026-01-05T00:00:00Z"))).toBe("20260105");
    expect(formatBuildDate(DateTime.makeUnsafe("2026-12-31T00:00:00Z"))).toBe("20261231");
  });

  it("composes and parses nightly versions symmetrically", () => {
    const version = composeNightlyVersion("0.0.32", "staging", "20260810", 3);
    expect(version).toBe("0.0.32-staging-nightly.20260810.3");
    expect(parseNightlyVersion(version)).toEqual({
      baseVersion: "0.0.32",
      variant: "staging",
      date: "20260810",
      counter: 3,
    });
  });

  it("puts the channel first, because that is what electron-updater matches", () => {
    // GitHubProvider takes semver.prerelease(tag)[0] and compares it to the
    // running app's channel. If the channel were not the first identifier, both
    // apps would resolve to the same releases.
    const staging = composeNightlyVersion("0.0.32", "staging", "20260810", 1);
    const production = composeNightlyVersion("0.0.32", "production", "20260810", 1);
    expect(staging.split("-")[1]).toBe("staging");
    expect(production.split("-")[1]).toBe("production");
    expect(staging).not.toBe(production);
  });

  it("keeps the -nightly suffix that upstream's own checks depend on", () => {
    // resolveDesktopUpdateChannel and isNightlyDesktopVersion both test
    // /-nightly\.\d{8}\.\d+$/. Losing this suffix would silently route fork
    // builds to the stable channel and publish them as full releases.
    const suffixPattern = /-nightly\.\d{8}\.\d+$/;
    expect(composeNightlyVersion("0.0.32", "staging", "20260810", 1)).toMatch(suffixPattern);
    expect(composeNightlyVersion("0.0.32", "production", "20260810", 1)).toMatch(suffixPattern);
  });

  it("rejects malformed composed versions rather than shipping them", () => {
    expect(() => composeNightlyVersion("0.0", "staging", "20260810", 1)).toThrow();
    expect(() => composeNightlyVersion("0.0.32", "staging", "2026081", 1)).toThrow();
    expect(() => composeNightlyVersion("0.0.32", "staging", "20260810", 0)).not.toThrow();
  });

  it("does not parse non-nightly or channel-less versions", () => {
    expect(parseNightlyVersion("0.0.32")).toBeUndefined();
    expect(parseNightlyVersion("0.0.32-alpha.1")).toBeUndefined();
    expect(parseNightlyVersion("0.0.32-staging-nightly.20260810")).toBeUndefined();
    // The old channel-less shape must not parse: it would be ambiguous between
    // the two apps.
    expect(parseNightlyVersion("0.0.32-nightly.20260810.1")).toBeUndefined();
    expect(parseNightlyVersion("0.0.32-beta-nightly.20260810.1")).toBeUndefined();
  });

  it("round-trips tags and versions", () => {
    expect(tagFromVersion("0.0.32-staging-nightly.20260810.1")).toBe(
      "v0.0.32-staging-nightly.20260810.1",
    );
    expect(versionFromTag("v0.0.32-staging-nightly.20260810.1")).toBe(
      "0.0.32-staging-nightly.20260810.1",
    );
    expect(versionFromTag("0.0.32-staging-nightly.20260810.1")).toBe(
      "0.0.32-staging-nightly.20260810.1",
    );
  });

  it("names one updater channel and manifest per app", () => {
    expect(updateChannelForVariant("staging")).toBe("staging-nightly");
    expect(updateChannelForVariant("production")).toBe("production-nightly");
    expect(updateManifestFileName("staging")).toBe("staging-nightly-mac.yml");
    expect(updateManifestFileName("production")).toBe("production-nightly-mac.yml");
  });
});

describe("release.yml trigger safety", () => {
  it("accepts nightly-form tags for both channels, which release.yml excludes", () => {
    // release.yml triggers on v*.*.* with !v*-nightly.* excluded. Both of these
    // contain "-nightly." and so fall inside the exclusion.
    expect(isReleaseWorkflowSafeTag("v0.0.32-staging-nightly.20260810.1")).toBe(true);
    expect(isReleaseWorkflowSafeTag("v0.0.32-production-nightly.20260810.1")).toBe(true);
  });

  it("rejects every tag shape that release.yml's v*.*.* trigger would match", () => {
    // Each of these would publish t3 to npm and re-alias app.t3.codes.
    expect(isReleaseWorkflowSafeTag("v0.0.32")).toBe(false);
    expect(isReleaseWorkflowSafeTag("v1.2.3-alpha.1")).toBe(false);
    expect(isReleaseWorkflowSafeTag("v0.0.0-test.1")).toBe(false);
    expect(isReleaseWorkflowSafeTag("v0.0.32-nightly")).toBe(false);
    expect(isReleaseWorkflowSafeTag("bk-desktop-20260810")).toBe(false);
    expect(isReleaseWorkflowSafeTag("0.0.32-staging-nightly.20260810.1")).toBe(false);
    // An unknown channel is not a channel we publish, so it is not safe either.
    expect(isReleaseWorkflowSafeTag("v0.0.32-beta-nightly.20260810.1")).toBe(false);
  });
});

describe("nightly ordering and counters", () => {
  const parse = (version: string) => {
    const parsed = parseNightlyVersion(version);
    if (!parsed) throw new Error(`unparseable: ${version}`);
    return parsed;
  };

  it("orders by base version, then date, then counter", () => {
    expect(
      compareNightlyVersions(
        parse("0.0.32-staging-nightly.20260810.1"),
        parse("0.0.32-staging-nightly.20260810.2"),
      ),
    ).toBeLessThan(0);
    expect(
      compareNightlyVersions(
        parse("0.0.32-staging-nightly.20260811.1"),
        parse("0.0.32-staging-nightly.20260810.9"),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareNightlyVersions(
        parse("0.0.33-staging-nightly.20260101.1"),
        parse("0.0.32-staging-nightly.20261231.9"),
      ),
    ).toBeGreaterThan(0);
    // Base version compares numerically, not as strings: 10 > 9.
    expect(
      compareNightlyVersions(
        parse("0.0.10-staging-nightly.20260810.1"),
        parse("0.0.9-staging-nightly.20260810.1"),
      ),
    ).toBeGreaterThan(0);
  });

  it("starts at 1 and increments within the same channel, base version and date", () => {
    expect(resolveNextCounter([], "staging", "0.0.32", "20260810")).toBe(1);
    expect(
      resolveNextCounter(
        ["v0.0.32-staging-nightly.20260810.1", "v0.0.32-staging-nightly.20260810.2"],
        "staging",
        "0.0.32",
        "20260810",
      ),
    ).toBe(3);
  });

  it("counts each app's builds separately", () => {
    // The whole point of the split: a staging build published earlier today must
    // not consume production's counter, or the two release lines interleave and
    // each app's version history stops being contiguous.
    const published = [
      "v0.0.32-staging-nightly.20260810.1",
      "v0.0.32-staging-nightly.20260810.2",
      "v0.0.32-staging-nightly.20260810.3",
    ];
    expect(resolveNextCounter(published, "staging", "0.0.32", "20260810")).toBe(4);
    expect(resolveNextCounter(published, "production", "0.0.32", "20260810")).toBe(1);
  });

  it("restarts the counter on a new date or base version", () => {
    const published = ["v0.0.32-staging-nightly.20260810.7"];
    expect(resolveNextCounter(published, "staging", "0.0.32", "20260811")).toBe(1);
    expect(resolveNextCounter(published, "staging", "0.0.33", "20260810")).toBe(1);
  });

  it("ignores unrelated and upstream-shaped tags when counting", () => {
    expect(
      resolveNextCounter(
        [
          "v0.0.32",
          "some-other-tag",
          "v0.0.32-nightly.20260810.9",
          "v0.0.32-staging-nightly.20260810.4",
        ],
        "staging",
        "0.0.32",
        "20260810",
      ),
    ).toBe(5);
  });

  it("finds the newest published version for one app only", () => {
    const published = [
      "v0.0.32-staging-nightly.20260810.1",
      "v0.0.33-staging-nightly.20260101.9",
      "v0.0.32-staging-nightly.20260811.4",
      "v0.0.99-production-nightly.20261231.9",
    ];
    // The much newer production release must not be mistaken for staging's, or
    // every staging build would be rejected as "not newer".
    expect(resolveNewestNightlyVersion(published, "staging")).toEqual({
      baseVersion: "0.0.33",
      variant: "staging",
      date: "20260101",
      counter: 9,
    });
    expect(resolveNewestNightlyVersion(published, "production")).toEqual({
      baseVersion: "0.0.99",
      variant: "production",
      date: "20261231",
      counter: 9,
    });
    expect(resolveNewestNightlyVersion(["v0.0.32", "junk"], "staging")).toBeUndefined();
  });
});

describe("release asset selection", () => {
  it("includes the installer and everything auto-update needs", () => {
    expect(
      isNightlyReleaseAsset("BK-T3-Code-0.0.32-staging-nightly.20260810.1-arm64.dmg", "staging"),
    ).toBe(true);
    // Squirrel.Mac update payload.
    expect(
      isNightlyReleaseAsset("BK-T3-Code-0.0.32-staging-nightly.20260810.1-arm64.zip", "staging"),
    ).toBe(true);
    // Differential download map and the manifest electron-updater reads.
    expect(isNightlyReleaseAsset("BK-T3-Code-0.0.32-arm64.dmg.blockmap", "staging")).toBe(true);
    expect(isNightlyReleaseAsset("staging-nightly-mac.yml", "staging")).toBe(true);
  });

  it("excludes the other app's manifest", () => {
    // Both apps build into release/. Attaching production's manifest to a
    // staging release would point production users at staging artifacts.
    expect(isNightlyReleaseAsset("production-nightly-mac.yml", "staging")).toBe(false);
    expect(isNightlyReleaseAsset("staging-nightly-mac.yml", "production")).toBe(false);
  });

  it("excludes the stable manifest and build leftovers", () => {
    // latest-mac.yml belongs to the stable channel; publishing it here would be
    // misleading and is never read by a nightly-channel client.
    expect(isNightlyReleaseAsset("latest-mac.yml", "staging")).toBe(false);
    expect(isNightlyReleaseAsset("nightly-mac.yml", "staging")).toBe(false);
    expect(isNightlyReleaseAsset("builder-debug.yml", "staging")).toBe(false);
    expect(isNightlyReleaseAsset("BK T3 Code.app", "staging")).toBe(false);
  });
});
