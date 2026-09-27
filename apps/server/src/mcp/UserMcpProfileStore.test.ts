import { expect, it } from "vite-plus/test";

import { canonicalizePersonalMcpIntegration } from "./UserMcpProfileStore.ts";

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
