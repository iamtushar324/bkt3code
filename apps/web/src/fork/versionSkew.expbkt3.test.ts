import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const branding = vi.hoisted(() => ({ APP_VERSION: "0.0.46-production-nightly.20261019.2" }));
vi.mock("../branding", () => branding);

import { resolveVersionMismatch } from "../versionSkew";

describe("BK desktop version skew", () => {
  beforeEach(() => {
    branding.APP_VERSION = "0.0.46-production-nightly.20261019.2";
  });

  it.each(["0.0.46-production-nightly.20261019.2", "0.0.46-stage-nightly.20261019.2"])(
    "treats packaged fork version %s as equal to its source version",
    (clientVersion) => {
      branding.APP_VERSION = clientVersion;

      expect(resolveVersionMismatch("0.0.45")).toBeNull();
    },
  );

  it.each([
    "0.0.47-production-nightly.20261019.2",
    "0.0.46-nightly.20261019.2",
    "0.0.46-production-nightly.20261019",
  ])("does not suppress real or non-fork skew for client version %s", (clientVersion) => {
    branding.APP_VERSION = clientVersion;

    expect(resolveVersionMismatch("0.0.45")).toMatchObject({
      clientVersion,
      serverVersion: "0.0.45",
    });
  });

  it("requires the server to report a plain committed version", () => {
    expect(resolveVersionMismatch("0.0.45-nightly.20261018.1")).toMatchObject({
      clientVersion: branding.APP_VERSION,
      serverVersion: "0.0.45-nightly.20261018.1",
    });
  });
});
