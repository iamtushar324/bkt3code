import {
  TOOLYARD_MCP_URL,
  type PersonalMcpIntegration,
  type PersonalMcpProfile,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  shouldAutoConnectToolyard,
  toolyardConnectErrorMessage,
  toolyardIntegrationOf,
} from "./toolyardConnect";

const toolyard = (credentialConfigured: boolean): PersonalMcpIntegration => ({
  id: "toolyard",
  name: "toolyard",
  url: TOOLYARD_MCP_URL,
  enabled: true,
  authMode: "bearer",
  customHeaderName: "",
  credentialConfigured,
  providerInstanceIds: [],
  allowedTools: [],
});

const profileWith = (integrations: ReadonlyArray<PersonalMcpIntegration>): PersonalMcpProfile => ({
  userId: "user_1" as PersonalMcpProfile["userId"],
  externalAccessEnabled: false,
  externalTokenConfigured: false,
  externalTokenPrefix: "",
  integrations,
  updatedAt: "2026-10-02T07:00:00.000Z",
});

describe("toolyardIntegrationOf", () => {
  it("finds the built-in entry and nothing else", () => {
    expect(toolyardIntegrationOf(profileWith([toolyard(true)]))?.credentialConfigured).toBe(true);
    expect(toolyardIntegrationOf(profileWith([]))).toBeNull();
    expect(toolyardIntegrationOf(null)).toBeNull();
  });
});

describe("shouldAutoConnectToolyard", () => {
  it("connects a signed-in operator whose profile shows no toolyard credential", () => {
    expect(
      shouldAutoConnectToolyard({
        signedIn: true,
        profile: profileWith([toolyard(false)]),
        attempted: false,
      }),
    ).toBe(true);
  });

  it("does nothing while signed out, before the profile loads, once connected, or after one try", () => {
    const pending = profileWith([toolyard(false)]);
    expect(shouldAutoConnectToolyard({ signedIn: false, profile: pending, attempted: false })).toBe(
      false,
    );
    expect(shouldAutoConnectToolyard({ signedIn: true, profile: null, attempted: false })).toBe(
      false,
    );
    expect(
      shouldAutoConnectToolyard({
        signedIn: true,
        profile: profileWith([toolyard(true)]),
        attempted: false,
      }),
    ).toBe(false);
    expect(shouldAutoConnectToolyard({ signedIn: true, profile: pending, attempted: true })).toBe(
      false,
    );
  });
});

describe("toolyardConnectErrorMessage", () => {
  it("words toolyard's refusals plainly", () => {
    expect(toolyardConnectErrorMessage("not_org_member")).toBe(
      "Your account isn't in the Beknown org.",
    );
    expect(toolyardConnectErrorMessage("agent_disabled")).toBe(
      "Your T3 Code agent is disabled in toolyard.",
    );
    expect(toolyardConnectErrorMessage("user_disabled")).toBe("Your toolyard account is disabled.");
  });

  it("falls back to a generic message that still names an unknown code", () => {
    expect(toolyardConnectErrorMessage("internal_error")).toBe(
      "toolyard could not be connected (internal_error).",
    );
    expect(toolyardConnectErrorMessage(undefined)).toBe("toolyard could not be connected.");
  });
});
