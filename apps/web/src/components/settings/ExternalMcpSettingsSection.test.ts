import { TOOLYARD_MCP_URL, type PersonalMcpProfile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildBifrostIntegration,
  formatExternalMcpApiKey,
  managedMcpIntegrations,
} from "./ExternalMcpSettingsSection";

describe("formatExternalMcpApiKey", () => {
  it("creates a stable high-entropy prefixed credential", () => {
    expect(formatExternalMcpApiKey(new Uint8Array([0, 1, 15, 16, 255]))).toBe("t3exp_00010f10ff");
  });
});

describe("buildBifrostIntegration", () => {
  it("uses the shared BeKnown Toolhub endpoint and only Bifrost virtual-key auth", () => {
    expect(buildBifrostIntegration()).toEqual({
      id: "bifrost",
      name: "Bifrost",
      url: "https://bk-toolhub.beknown.live/mcp",
      enabled: true,
      authMode: "x-bf-vk",
      customHeaderName: "",
      credentialConfigured: false,
      providerInstanceIds: [],
      allowedTools: [],
    });
  });
});

describe("managedMcpIntegrations", () => {
  const profile: PersonalMcpProfile = {
    userId: "user_1" as PersonalMcpProfile["userId"],
    externalAccessEnabled: false,
    externalTokenConfigured: false,
    externalTokenPrefix: "",
    integrations: [
      {
        id: "toolyard",
        name: "toolyard",
        url: TOOLYARD_MCP_URL,
        enabled: true,
        authMode: "bearer",
        customHeaderName: "",
        credentialConfigured: true,
        providerInstanceIds: [],
        allowedTools: [],
        connectedEmail: "tushar@beknown.work",
        connectedAt: "2026-10-02T07:00:00.000Z",
      },
      buildBifrostIntegration(),
    ],
    updatedAt: "2026-10-02T07:00:00.000Z",
  };

  it("leaves the built-in toolyard integration to its own card", () => {
    expect(managedMcpIntegrations(profile).map((integration) => integration.id)).toEqual([
      "bifrost",
    ]);
  });

  it("is empty before the profile has loaded", () => {
    expect(managedMcpIntegrations(null)).toEqual([]);
    expect(managedMcpIntegrations(undefined)).toEqual([]);
  });
});
