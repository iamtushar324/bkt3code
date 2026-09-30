import {
  BIFROST_MCP_URL,
  isAllowedBifrostGatewayUrl,
  type PersonalMcpIntegrationUpdate,
  TOOLYARD_MCP_URL,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canonicalizePersonalMcpIntegration } from "./UserMcpProfileStore.ts";

const bifrostIntegration = (url: string): PersonalMcpIntegrationUpdate => ({
  id: "bifrost",
  name: "Redirected Bifrost",
  url,
  enabled: true,
  authMode: "x-bf-vk",
  customHeaderName: "x-custom",
  credential: "virtual-key",
  providerInstanceIds: [],
  allowedTools: [],
});

it("forces Bifrost virtual-key integrations through the shared Toolhub endpoint", () => {
  expect(
    canonicalizePersonalMcpIntegration({
      id: "bifrost",
      name: "Redirected Bifrost",
      url: "https://attacker.example/mcp",
      enabled: true,
      authMode: "x-bf-vk",
      customHeaderName: "x-custom",
      credential: "virtual-key",
      providerInstanceIds: [],
      allowedTools: [],
    }),
  ).toEqual({
    id: "bifrost",
    name: "Bifrost",
    url: "https://bk-toolhub.beknown.live/mcp",
    enabled: true,
    authMode: "x-bf-vk",
    customHeaderName: "",
    credential: "virtual-key",
    providerInstanceIds: [],
    allowedTools: [],
  });
});

describe("Bifrost-compatible gateway allowlist", () => {
  it("keeps the toolyard gateway and only relabels the integration", () => {
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(TOOLYARD_MCP_URL))).toEqual({
      id: "bifrost",
      name: "Bifrost (toolyard)",
      url: "https://toolyard.dev.beknown.live/mcp",
      enabled: true,
      authMode: "x-bf-vk",
      customHeaderName: "",
      credential: "virtual-key",
      providerInstanceIds: [],
      allowedTools: [],
    });
  });

  it("keeps Bifrost as the default gateway", () => {
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(BIFROST_MCP_URL))).toMatchObject({
      id: "bifrost",
      name: "Bifrost",
      url: "https://bk-toolhub.beknown.live/mcp",
    });
  });

  it.each([
    "https://toolyard.dev.beknown.live/mcp/",
    "https://toolyard.dev.beknown.live/mcp//",
    "HTTPS://Toolyard.Dev.Beknown.Live/MCP",
    "  https://toolyard.dev.beknown.live:443/mcp  ",
  ])("stores the canonical toolyard URL for %s", (url) => {
    expect(isAllowedBifrostGatewayUrl(url)).toBe(true);
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(url))).toMatchObject({
      name: "Bifrost (toolyard)",
      url: TOOLYARD_MCP_URL,
    });
  });

  it.each([
    "https://toolyard.dev.beknown.live.evil.com/mcp",
    "https://toolyard.dev.beknown.live./mcp",
    "https://toolyard.dev.beknown.live@evil.com/mcp",
    "https://user:pass@toolyard.dev.beknown.live/mcp",
    "https://evil.com/https://toolyard.dev.beknown.live/mcp",
    "https://evil.com/mcp?host=toolyard.dev.beknown.live",
    "https://toolyard.dev.beknown.live/mcpx",
    "https://toolyard.dev.beknown.live/mcp/extra",
    "https://toolyard.dev.beknown.live/mcp?next=https://evil.com",
    "https://toolyard.dev.beknown.live/mcp#fragment",
    "https://toolyard.dev.beknown.live:8443/mcp",
    "http://toolyard.dev.beknown.live/mcp",
    "not a url",
  ])("rewrites the lookalike %s to Bifrost", (url) => {
    expect(isAllowedBifrostGatewayUrl(url)).toBe(false);
    expect(canonicalizePersonalMcpIntegration(bifrostIntegration(url))).toMatchObject({
      name: "Bifrost",
      url: BIFROST_MCP_URL,
    });
  });

  it("leaves integrations that do not carry a Bifrost virtual key untouched", () => {
    const integration: PersonalMcpIntegrationUpdate = {
      ...bifrostIntegration("https://mcp.example.com/mcp"),
      id: "example",
      name: "Example",
      authMode: "bearer",
    };
    expect(canonicalizePersonalMcpIntegration(integration)).toBe(integration);
  });
});
