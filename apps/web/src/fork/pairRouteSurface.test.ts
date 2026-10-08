import { describe, expect, it } from "vite-plus/test";

import { resolvePairRouteSurface } from "./pairRouteSurface";

describe("resolvePairRouteSurface", () => {
  it("redeems a pairing link in team mode instead of showing the Clerk gate", () => {
    expect(
      resolvePairRouteSurface({
        teamMode: true,
        hasPairingToken: true,
        explicitPairingRequested: false,
      }),
    ).toBe("pairing");
  });

  it("keeps the pairing surface after the link's token was stripped", () => {
    expect(
      resolvePairRouteSurface({
        teamMode: true,
        hasPairingToken: false,
        explicitPairingRequested: true,
      }),
    ).toBe("pairing");
  });

  it("shows the Clerk gate in team mode without a pairing link", () => {
    expect(
      resolvePairRouteSurface({
        teamMode: true,
        hasPairingToken: false,
        explicitPairingRequested: false,
      }),
    ).toBe("clerk");
  });

  it("always shows the pairing surface outside team mode", () => {
    expect(
      resolvePairRouteSurface({
        teamMode: false,
        hasPairingToken: false,
        explicitPairingRequested: false,
      }),
    ).toBe("pairing");
  });
});
