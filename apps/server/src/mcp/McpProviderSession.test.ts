import { describe, expect, it } from "vite-plus/test";

import { upstreamMcpServerName, withAgentDeviceEnvironment } from "./McpProviderSession.ts";

describe("upstreamMcpServerName", () => {
  it("exposes the shared Bifrost integration under the expected MCP namespace", () => {
    expect(
      upstreamMcpServerName({
        id: "bifrost",
        name: "Bifrost",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/bifrost",
        authMode: "x-bf-vk",
        allowedTools: [],
      }),
    ).toBe("bifrost");
  });

  it("keeps custom user integrations isolated under a reserved namespace", () => {
    expect(
      upstreamMcpServerName({
        id: "custom-tools",
        name: "Custom tools",
        endpoint: "http://127.0.0.1:43123/mcp/upstream/custom-tools",
        authMode: "bearer",
        allowedTools: [],
      }),
    ).toBe("t3_user_custom_tools");
  });
});

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});
