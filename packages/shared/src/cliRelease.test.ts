import { describe, expect, it } from "vite-plus/test";

// T3-CUSTOM(expbkt3): cliReleaseChannelOf for the fork version test.
import {
  cliArchiveTarCommand,
  cliReleaseChannelOf,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  // T3-CUSTOM(expbkt3): fork stage/production builds stay on the nightly track.
  it("reads fork channel-prefixed and upstream-suffixed versions as nightly", () => {
    expect(cliReleaseChannelOf("0.0.32-stage-nightly.20260810.1")).toBe("nightly");
    expect(cliReleaseChannelOf("0.0.32-production-nightly.20260810.1")).toBe("nightly");
    expect(cliReleaseChannelOf("0.1.7-nightly.20261103.4119.upstream.g05b697f6a201")).toBe(
      "nightly",
    );
    expect(cliReleaseChannelOf("0.1.7-nightly.20261103.4119")).toBe("nightly");
    expect(cliReleaseChannelOf("0.1.7")).toBe("stable");
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
