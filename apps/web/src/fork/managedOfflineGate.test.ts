import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  __resetBkManagedEnvironmentForTests,
  __setBkManagedEnvironmentForTests,
} from "./managedEnvironment";
import {
  resolveManagedOfflineAuthGateState,
  shouldEnterOfflineAuthenticatedState,
} from "./managedOfflineGate";
import { __resetManagedPrimaryCredentialForTests } from "./managedPrimaryCredential";

describe("shouldEnterOfflineAuthenticatedState", () => {
  it("requires both a managed primary and a stored token", () => {
    expect(
      shouldEnterOfflineAuthenticatedState({ managedPrimary: true, storedAccessToken: "token" }),
    ).toBe(true);
    expect(
      shouldEnterOfflineAuthenticatedState({ managedPrimary: true, storedAccessToken: null }),
    ).toBe(false);
    expect(
      shouldEnterOfflineAuthenticatedState({ managedPrimary: false, storedAccessToken: "token" }),
    ).toBe(false);
    expect(
      shouldEnterOfflineAuthenticatedState({ managedPrimary: false, storedAccessToken: null }),
    ).toBe(false);
  });
});

describe("resolveManagedOfflineAuthGateState", () => {
  afterEach(() => {
    __resetBkManagedEnvironmentForTests();
    __resetManagedPrimaryCredentialForTests();
  });

  it("propagates the failure on an unmanaged primary", async () => {
    // Upstream desktop and self-hosted web reach their primary on loopback or
    // same-origin; a thrown session probe there means the app is broken, so
    // the error screen must stay.
    expect(await resolveManagedOfflineAuthGateState(new Error("offline"))).toBeNull();
  });

  it("propagates the failure on a managed primary with no stored pairing token", async () => {
    __setBkManagedEnvironmentForTests({
      channel: "staging",
      httpBaseUrl: "https://expbkt3.dev.beknown.live",
      wsBaseUrl: "wss://expbkt3.dev.beknown.live",
    });
    // A fresh install that never paired has nothing to be optimistic about —
    // the pairing gate (reached when the server is back) stays the answer.
    expect(await resolveManagedOfflineAuthGateState(new Error("offline"))).toBeNull();
  });
});
