import { describe, expect, it } from "vite-plus/test";

import { BK_SIGNING_IDENTITY_ENV_VAR, resolveBkSigningIdentity } from "./bk-desktop-signing.ts";

describe("bk-desktop-signing", () => {
  it("treats an absent or blank identity as unsigned", () => {
    // electron-builder treats a set-but-empty variable as enabled, which would
    // make it look for an identity named "" and fail deep inside the build.
    expect(resolveBkSigningIdentity({})).toBeUndefined();
    expect(resolveBkSigningIdentity({ [BK_SIGNING_IDENTITY_ENV_VAR]: "" })).toBeUndefined();
    expect(resolveBkSigningIdentity({ [BK_SIGNING_IDENTITY_ENV_VAR]: "   " })).toBeUndefined();
  });

  it("returns the trimmed certificate common name", () => {
    expect(resolveBkSigningIdentity({ [BK_SIGNING_IDENTITY_ENV_VAR]: " BK Code Signing " })).toBe(
      "BK Code Signing",
    );
  });
});
