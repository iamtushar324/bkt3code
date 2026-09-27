/**
 * T3-CUSTOM(expbkt3): the client half of device-bound pairing.
 *
 * The two things worth pinning here are the token's validity rules — a token
 * bound to a key this device no longer has is worthless and must not be
 * presented — and the promise that none of this disturbs the saved-environment
 * model every other client stores its credentials in.
 */
import {
  BearerConnectionCredential,
  ConnectionCredential,
} from "@t3tools/client-runtime/connection";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  __resetBkManagedEnvironmentForTests,
  __setBkManagedEnvironmentForTests,
} from "./managedEnvironment";
import {
  isManagedPrimaryCredentialUsable,
  parseStoredManagedPrimaryCredential,
} from "./managedPrimaryCredential";
import { managedPrimarySocketUrl } from "./managedPrimaryConnection";

const MANAGED_HTTP = "https://bkt3.dev.beknown.live";
const THUMBPRINT = "thumbprint-a";

const storedCredential = {
  httpBaseUrl: MANAGED_HTTP,
  accessToken: "token-1",
  expiresAtEpochMs: 10_000_000,
  dpopThumbprint: THUMBPRINT,
};

describe("stored managed primary credential", () => {
  afterEach(() => {
    __resetBkManagedEnvironmentForTests();
  });

  it("round-trips a complete record", () => {
    expect(parseStoredManagedPrimaryCredential(JSON.stringify(storedCredential))).toEqual(
      storedCredential,
    );
  });

  it("rejects a record written before the token was device-bound", () => {
    const { dpopThumbprint: _dropped, ...withoutThumbprint } = storedCredential;
    expect(parseStoredManagedPrimaryCredential(JSON.stringify(withoutThumbprint))).toBeNull();
    expect(parseStoredManagedPrimaryCredential("not json")).toBeNull();
    expect(parseStoredManagedPrimaryCredential(null)).toBeNull();
  });

  it("is usable only for its own server, before expiry, with its own key", () => {
    const now = storedCredential.expiresAtEpochMs - 5 * 60_000;

    expect(isManagedPrimaryCredentialUsable(storedCredential, MANAGED_HTTP, now, THUMBPRINT)).toBe(
      true,
    );

    // A build switched between channels.
    expect(
      isManagedPrimaryCredentialUsable(
        storedCredential,
        "https://expbkt3.dev.beknown.live",
        now,
        THUMBPRINT,
      ),
    ).toBe(false);

    // The device key was regenerated (cleared storage, new profile): the server
    // still pins the session to the old thumbprint, so the token is dead.
    expect(
      isManagedPrimaryCredentialUsable(storedCredential, MANAGED_HTTP, now, "thumbprint-b"),
    ).toBe(false);

    // No key at all.
    expect(isManagedPrimaryCredentialUsable(storedCredential, MANAGED_HTTP, now, null)).toBe(false);

    // Expired, including the skew window.
    expect(
      isManagedPrimaryCredentialUsable(
        storedCredential,
        MANAGED_HTTP,
        storedCredential.expiresAtEpochMs - 1_000,
        THUMBPRINT,
      ),
    ).toBe(false);
  });

  it("builds the websocket URL with the issued ticket", () => {
    expect(managedPrimarySocketUrl("wss://bkt3.dev.beknown.live", "ticket-1")).toBe(
      "wss://bkt3.dev.beknown.live/ws?wsTicket=ticket-1",
    );
    expect(managedPrimarySocketUrl("wss://bkt3.dev.beknown.live/socket", "ticket-1")).toBe(
      "wss://bkt3.dev.beknown.live/socket?wsTicket=ticket-1",
    );
  });
});

describe("the saved-environment model is untouched", () => {
  const isConnectionCredential = Schema.is(ConnectionCredential);

  it("still stores bearer credentials only", () => {
    expect(isConnectionCredential(new BearerConnectionCredential({ token: "t" }))).toBe(true);
    // The managed primary's DPoP token lives in the fork's own store, precisely so
    // this persisted union — shared by web, mobile and desktop — needs no new member
    // and no storage migration.
    expect(isConnectionCredential({ _tag: "DpopConnectionCredential", token: "t" })).toBe(false);
  });

  it("keeps the relay-shaped remote DPoP token store", () => {
    // Still requires a relay-managed endpoint: nothing here was widened to carry a
    // direct environment, so no persisted client document changed shape.
    const decode = Schema.decodeUnknownSync(TokenStore.RemoteDpopAccessToken);
    expect(() =>
      decode({
        environmentId: "env-1",
        label: "Relay",
        endpoint: {
          httpBaseUrl: "https://example.invalid",
          wsBaseUrl: "wss://example.invalid",
          providerKind: "t3_relay",
        },
        accessToken: "token",
        expiresAtEpochMs: 1,
        dpopThumbprint: "thumb",
      }),
    ).not.toThrow();
    expect(() =>
      decode({
        environmentId: "env-1",
        label: "Direct",
        endpoint: { httpBaseUrl: "https://example.invalid", wsBaseUrl: "wss://example.invalid" },
        accessToken: "token",
        expiresAtEpochMs: 1,
        dpopThumbprint: "thumb",
      }),
    ).toThrow();
  });
});

describe("an unmanaged build has no DPoP primary authorization", () => {
  afterEach(() => {
    __resetBkManagedEnvironmentForTests();
  });

  it("is the default", async () => {
    const { readManagedPrimaryDpopAuthorization } = await import("./managedPrimaryConnection");
    const { runPromise } = await import("effect/Effect");
    const { isNone } = await import("effect/Option");
    expect(isNone(await runPromise(readManagedPrimaryDpopAuthorization))).toBe(true);
  });

  it("stays none in a managed build until the operator has paired", async () => {
    __setBkManagedEnvironmentForTests({
      channel: "production",
      httpBaseUrl: MANAGED_HTTP,
      wsBaseUrl: "wss://bkt3.dev.beknown.live",
    });
    const { readManagedPrimaryDpopAuthorization } = await import("./managedPrimaryConnection");
    const { runPromise } = await import("effect/Effect");
    const { isNone } = await import("effect/Option");
    expect(isNone(await runPromise(readManagedPrimaryDpopAuthorization))).toBe(true);
  });
});
