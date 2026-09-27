/**
 * T3-CUSTOM(expbkt3): rules behind the member "Your devices" panel.
 */
import { AuthAccessWriteScope, AuthStandardClientScopes } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "../environments/primary/auth";
import {
  MEMBER_PAIRING_LIMIT_MESSAGE,
  memberPairingErrorMessage,
  shouldShowMemberDevices,
  toMemberDeviceSessions,
  toMemberPendingPairings,
} from "./memberDevices";

const link = (id: string, expiresAt: string, label?: string): ServerPairingLinkRecord =>
  ({ id, expiresAt, ...(label === undefined ? {} : { label }) }) as ServerPairingLinkRecord;

const session = (
  sessionId: string,
  method: ServerClientSessionRecord["method"],
  extra?: Partial<ServerClientSessionRecord>,
): ServerClientSessionRecord =>
  ({
    sessionId,
    method,
    client: {},
    current: false,
    lastConnectedAt: null,
    ...extra,
  }) as ServerClientSessionRecord;

describe("who sees the member panel", () => {
  it("shows it to a member with an identity and no access:write", () => {
    expect(
      shouldShowMemberDevices({ scopes: [...AuthStandardClientScopes], userId: "user_1" }),
    ).toBe(true);
  });

  it("hides it from an access:write holder, who keeps the administrative panel", () => {
    expect(
      shouldShowMemberDevices({
        scopes: [...AuthStandardClientScopes, AuthAccessWriteScope],
        userId: "user_1",
      }),
    ).toBe(false);
  });

  it("hides it from a session with no identity", () => {
    expect(shouldShowMemberDevices({ scopes: [...AuthStandardClientScopes], userId: null })).toBe(
      false,
    );
    expect(shouldShowMemberDevices({ scopes: null, userId: "user_1" })).toBe(false);
  });
});

describe("what the panel lists", () => {
  it("orders pending codes by how soon they expire", () => {
    expect(
      toMemberPendingPairings([
        link("later", "2026-01-01T02:00:00.000Z", "Phone"),
        link("sooner", "2026-01-01T01:00:00.000Z"),
      ]).map((pending) => pending.id),
    ).toEqual(["sooner", "later"]);
    expect(toMemberPendingPairings([link("a", "2026-01-01T00:00:00.000Z")])[0]?.label).toBeNull();
  });

  it("lists paired devices but not browser sign-ins", () => {
    const devices = toMemberDeviceSessions([
      session("bearer", "bearer-access-token"),
      session("dpop", "dpop-access-token"),
      session("browser", "browser-session-cookie"),
    ]);
    expect(devices.map((device) => device.sessionId)).toEqual(["bearer", "dpop"]);
    expect(devices.find((device) => device.sessionId === "dpop")?.deviceBound).toBe(true);
    expect(devices.find((device) => device.sessionId === "bearer")?.deviceBound).toBe(false);
  });
});

describe("the at-cap refusal", () => {
  it("turns the server's reason into advice", () => {
    expect(memberPairingErrorMessage({ reason: "self_pairing_limit_reached" })).toBe(
      MEMBER_PAIRING_LIMIT_MESSAGE,
    );
  });

  it("passes anything else through", () => {
    expect(memberPairingErrorMessage(new Error("network down"))).toBe("network down");
    expect(memberPairingErrorMessage("odd")).toBe("Could not create a pairing code.");
  });
});
