import { describe, expect, it } from "vite-plus/test";

import { assertKeylessBuild, parseArgs, xcodeSchemeName } from "./build-bk-mobile.ts";
import {
  bkAppVersionString,
  bkArtifactFileName,
  bkBuildEnv,
  bkReleaseTag,
  parseBkIosBuildNumber,
  parseMobileAppVersion,
} from "./lib/bk-mobile.ts";

describe("parseArgs", () => {
  it("requires a supported platform", () => {
    expect(parseArgs(["--platform", "ios"]).platform).toBe("ios");
    expect(() => parseArgs([])).toThrow(/--platform is required/);
    expect(() => parseArgs(["--platform", "web"])).toThrow(/android/);
    expect(() => parseArgs(["--wat"])).toThrow(/Unknown argument/);
  });
});

describe("assertKeylessBuild", () => {
  it("rejects a Clerk key from either source", () => {
    expect(() => assertKeylessBuild({}, [])).not.toThrow();
    expect(() => assertKeylessBuild({ PATH: "/usr/bin" }, ["FOO=bar\n"])).not.toThrow();
    expect(() => assertKeylessBuild({}, ["EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test\n"])).toThrow(
      /keyless/,
    );
    expect(() => assertKeylessBuild({ EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk" }, [])).toThrow(
      /keyless/,
    );
  });

  it("ignores a commented-out key", () => {
    expect(() =>
      assertKeylessBuild({}, ["# EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY=pk\n"]),
    ).not.toThrow();
  });
});

describe("build identity", () => {
  it("stamps version and artifact names from the build SHA", () => {
    expect(bkAppVersionString("1.0.4", "a1b2c3d4e5f6")).toBe("1.0.4+bk.a1b2c3d");
    expect(bkArtifactFileName("android", "1.0.4", "a1b2c3d4e5f6")).toBe(
      "bk-t3code-1.0.4-a1b2c3d.apk",
    );
    expect(bkArtifactFileName("ios", "1.0.4", "a1b2c3d4e5f6")).toBe("bk-t3code-1.0.4-a1b2c3d.ipa");
    // The release tag has to agree with the artifact names, because the
    // workflow derives one and the build script the other.
    expect(bkReleaseTag("1.0.4", "a1b2c3d4e5f6")).toBe("bk-mobile-v1.0.4-a1b2c3d");
  });

  it("pins the environment both platforms need", () => {
    const env = bkBuildEnv("abc1234");
    expect(env.T3CODE_BK_MOBILE).toBe("1");
    // Required on Android too: it is the single source of the fork bundle id.
    expect(env.T3CODE_IOS_PERSONAL_TEAM).toBe("1");
    expect(env.MOBILE_VERSION_POLICY).toBe("appVersion");
    expect(env.BK_GIT_SHA).toBe("abc1234");
  });

  it("derives the Xcode scheme the way Expo sanitises the app name", () => {
    expect(xcodeSchemeName("BK T3 Code")).toBe("BKT3Code");
  });

  it("accepts only positive integer iOS build numbers", () => {
    expect(parseBkIosBuildNumber(undefined)).toBeNull();
    expect(parseBkIosBuildNumber(" 17 ")).toBe("17");
    expect(() => parseBkIosBuildNumber("0")).toThrow(/positive integer/);
    expect(() => parseBkIosBuildNumber("17beta")).toThrow(/positive integer/);
  });
});

describe("parseMobileAppVersion", () => {
  it("reads the version the mobile app reports to servers", () => {
    expect(parseMobileAppVersion('export const MOBILE_APP_VERSION = "1.0.4";\n')).toBe("1.0.4");
  });

  it("fails rather than guessing when the constant moves", () => {
    // Parsed instead of imported to keep the script out of the mobile
    // TypeScript project, so a rename there must fail loudly here.
    expect(() => parseMobileAppVersion("export const OTHER = 1;")).toThrow(/MOBILE_APP_VERSION/);
  });
});
