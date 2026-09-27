import { describe, expect, it } from "vite-plus/test";

import { buildBifrostIntegration, formatExternalMcpApiKey } from "./ExternalMcpSettingsSection";

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
