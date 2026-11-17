/** T3-CUSTOM(expbkt3): The Toolyard default URL and the endpoints the server treats as Toolyard's. */
import { describe, expect, it } from "@effect/vitest";
import { isToolyardGatewayUrl } from "@t3tools/contracts";
import {
  resolveToolyardDefaultUrl,
  toolyardMcpUrlCandidates,
  toolyardOriginFromConfig,
} from "./toolyardDefaultUrl.ts";

describe("toolyard default URL", () => {
  it("uses the production instance when the environment names none", () => {
    for (const raw of [undefined, "", "   "])
      expect(resolveToolyardDefaultUrl(raw)).toEqual({
        url: "https://toolyard.beknown.live",
        source: "built-in",
      });
  });

  it("accepts an https origin, with or without the /mcp endpoint", () => {
    for (const raw of [
      "https://toolyard.dev.beknown.live",
      "https://toolyard.dev.beknown.live/",
      " https://toolyard.dev.beknown.live/mcp ",
      "https://TOOLYARD.dev.beknown.live/MCP/",
    ])
      expect(resolveToolyardDefaultUrl(raw)).toEqual({
        url: "https://toolyard.dev.beknown.live",
        source: "environment",
      });
  });

  it("falls back to the built-in URL for a value the server cannot use", () => {
    for (const raw of [
      "http://toolyard.test",
      "https://user:pass@toolyard.test",
      "https://toolyard.test/other",
      "https://toolyard.test/?x=1",
      "not a url",
    ]) {
      expect(toolyardOriginFromConfig(raw)).toBeNull();
      expect(resolveToolyardDefaultUrl(raw)).toEqual({
        url: "https://toolyard.beknown.live",
        source: "built-in",
        rejected: raw.trim(),
      });
    }
  });

  it("treats the configured, default and earlier endpoints as Toolyard's, and nothing else", () => {
    const urls = toolyardMcpUrlCandidates(["https://toolyard.example.test", null, undefined]);
    for (const url of [
      "https://toolyard.example.test/mcp",
      "https://toolyard.beknown.live/mcp/",
      "https://toolyard.dev.beknown.live/mcp",
    ])
      expect(isToolyardGatewayUrl(url, urls)).toBe(true);
    for (const url of [
      "https://toolyard.example.test.evil.com/mcp",
      "https://evil.com/mcp?host=toolyard.beknown.live",
      "https://toolyard.example.test/other",
    ])
      expect(isToolyardGatewayUrl(url, urls)).toBe(false);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
