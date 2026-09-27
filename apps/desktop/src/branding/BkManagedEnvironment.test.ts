import { describe, expect, it } from "vite-plus/test";

import { parseBkManagedEnvironment, readBkManagedEnvironment } from "./BkManagedEnvironment.ts";

describe("BkManagedEnvironment", () => {
  it("is disabled when the build-time define is absent", () => {
    expect(readBkManagedEnvironment()).toBeNull();
  });

  it("accepts a complete HTTPS managed environment", () => {
    expect(
      parseBkManagedEnvironment({
        channel: "staging",
        httpBaseUrl: "https://expbkt3.dev.beknown.live",
        wsBaseUrl: "wss://expbkt3.dev.beknown.live",
      }),
    ).toEqual({
      channel: "staging",
      httpBaseUrl: "https://expbkt3.dev.beknown.live",
      wsBaseUrl: "wss://expbkt3.dev.beknown.live",
    });
  });

  it.each([
    null,
    {},
    { channel: "preview", httpBaseUrl: "https://example.com", wsBaseUrl: "wss://example.com" },
    { channel: "production", httpBaseUrl: "http://example.com", wsBaseUrl: "wss://example.com" },
    { channel: "production", httpBaseUrl: "https://example.com", wsBaseUrl: "ws://example.com" },
  ])("rejects an unsafe or incomplete value", (value) => {
    expect(parseBkManagedEnvironment(value)).toBeNull();
  });
});
