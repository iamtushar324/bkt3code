import { describe, expect, it } from "vite-plus/test";

import { createBkMobileSource, parseArgs } from "./generate-bk-mobile-source.ts";

const input = {
  branch: "expbkmain" as const,
  repository: "beknown-work/bkt3code",
  version: "1.0.4",
  gitSha: "a1b2c3d4e5f6789012345678901234567890abcd",
  buildNumber: "17",
  date: "2026-09-01T12:34:56Z",
  ipaSize: 35_221_878,
  ipaSha256: "f".repeat(64),
};

describe("createBkMobileSource", () => {
  it("publishes a stable source URL and an immutable IPA URL", () => {
    const source = createBkMobileSource(input);
    expect(source.sourceURL).toBe(
      "https://github.com/beknown-work/bkt3code/releases/download/" +
        "bk-mobile-source-expbkmain/bk-mobile-expbkmain.json",
    );
    // The base version never moves; the run number is the fourth component so
    // SideStore sees every build as newer than the last.
    expect(source.apps[0]?.version).toBe("1.0.4.17");
    expect(source.apps[0]?.versions[0]).toMatchObject({
      version: "1.0.4.17",
      buildVersion: "17",
      marketingVersion: "1.0.4+bk.a1b2c3d",
      downloadURL:
        "https://github.com/beknown-work/bkt3code/releases/download/" +
        "bk-mobile-v1.0.4-a1b2c3d/bk-t3code-1.0.4-a1b2c3d.ipa",
      size: 35_221_878,
      sha256: "f".repeat(64),
      minOSVersion: "18.0",
    });
  });

  it("uses the unsigned app's original bundle identifier", () => {
    const source = createBkMobileSource(input);
    expect(source.apps[0]?.bundleIdentifier).toBe("work.beknown.bkt3code.mobile");
    expect(source.apps[0]?.appPermissions).toEqual({
      entitlements: [],
      privacy: {
        NSCameraUsageDescription:
          "Allow T3 Code to access your camera so you can scan pairing QR codes.",
        NSFaceIDUsageDescription: "Allow BKT3Code to access your Face ID biometric data.",
        NSLocalNetworkUsageDescription:
          "Allow T3 Code to connect to T3 Code servers on your local network or tailnet.",
      },
    });
  });
});

describe("parseArgs", () => {
  const argv = [
    "--branch",
    "expbkmain",
    "--repository",
    "beknown-work/bkt3code",
    "--version",
    "1.0.4",
    "--git-sha",
    "a1b2c3d4",
    "--build-number",
    "17",
    "--date",
    "2026-09-01T12:34:56Z",
    "--ipa",
    "release/mobile/bk-t3code-1.0.4-a1b2c3d.ipa",
  ];

  it("derives the channel-specific output name", () => {
    expect(parseArgs(argv).outputPath).toMatch(/release\/mobile\/bk-mobile-expbkmain\.json$/);
  });

  it("rejects channels and build numbers SideStore cannot order", () => {
    expect(() => parseArgs(argv.with(1, "feature"))).toThrow(/--branch/);
    expect(() => parseArgs(argv.with(9, "0"))).toThrow(/positive integer/);
  });
});
