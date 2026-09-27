import { describe, expect, it } from "vite-plus/test";

import { bkAppVersion, readBkGitSha } from "./bkBuildIdentity";

describe("bkAppVersion", () => {
  it("appends the abbreviated build SHA for fork builds", () => {
    expect(bkAppVersion("1.0.4", "a1b2c3d4e5f6789")).toBe("1.0.4+bk.a1b2c3d");
  });

  it("stays the plain version when no SHA was stamped", () => {
    // Upstream builds, and any dev client started from Metro.
    expect(bkAppVersion("1.0.4", null)).toBe("1.0.4");
  });

  it("produces valid semver build metadata", () => {
    // The server stores this verbatim as `client_version`; anything that parses
    // it must still see 1.0.4.
    expect(bkAppVersion("1.0.4", "abcdef1234")).toMatch(/^\d+\.\d+\.\d+\+[0-9A-Za-z.-]+$/);
  });
});

describe("readBkGitSha", () => {
  it("reads the SHA the build script stamped", () => {
    expect(readBkGitSha({ bk: { gitSha: "a1b2c3d" } })).toBe("a1b2c3d");
  });

  it("returns null for every shape a non-fork manifest can have", () => {
    expect(readBkGitSha(undefined)).toBeNull();
    expect(readBkGitSha(null)).toBeNull();
    expect(readBkGitSha({})).toBeNull();
    // The public manifest serialises an unset value to {}, which is truthy.
    expect(readBkGitSha({ bk: {} })).toBeNull();
    expect(readBkGitSha({ bk: { gitSha: null } })).toBeNull();
    expect(readBkGitSha({ bk: { gitSha: "   " } })).toBeNull();
    expect(readBkGitSha({ bk: { gitSha: 42 } })).toBeNull();
  });
});
