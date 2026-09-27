/**
 * T3-CUSTOM(expbkt3): the Clerk-token wiring behind identity-bearing pairing.
 *
 * This covers the seam between `TeamIdentityBridge`, which registers Clerk's
 * `getToken`, and the connection layer, which presents the result when pairing a
 * remote environment. The failure this guards against is silent: if the provider
 * is never registered or quietly returns null, pairing still "works" locally and
 * only fails against a team-mode environment, where it looks like a bad token.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readTeamClerkToken, setTeamClerkTokenProvider } from "./teamIdentityToken";

afterEach(() => {
  setTeamClerkTokenProvider(null);
});

describe("team Clerk identity token", () => {
  it("returns null before any provider is registered", async () => {
    await expect(readTeamClerkToken()).resolves.toBeNull();
  });

  it("mints through the registered provider on every read", async () => {
    let issued = 0;
    setTeamClerkTokenProvider(() => Promise.resolve(`clerk-token-${++issued}`));

    // Clerk session tokens are short-lived, so pairing must get a fresh one rather
    // than a value captured when the bridge mounted.
    await expect(readTeamClerkToken()).resolves.toBe("clerk-token-1");
    await expect(readTeamClerkToken()).resolves.toBe("clerk-token-2");
  });

  it("returns null once the provider is cleared on sign-out", async () => {
    setTeamClerkTokenProvider(() => Promise.resolve("clerk-token"));
    setTeamClerkTokenProvider(null);

    await expect(readTeamClerkToken()).resolves.toBeNull();
  });

  it("treats a Clerk failure as no identity rather than throwing", async () => {
    setTeamClerkTokenProvider(() => Promise.reject(new Error("Clerk unavailable")));

    await expect(readTeamClerkToken()).resolves.toBeNull();
  });

  // The capability that carries this into pairing is covered in
  // `connection/platform.test.ts`, where the connection layer's tests live.
});
