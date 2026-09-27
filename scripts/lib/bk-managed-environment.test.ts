import { describe, expect, it } from "@effect/vitest";

import {
  BK_MANAGED_CHANNEL_ENV_VAR,
  BK_MANAGED_ENVIRONMENTS,
  isBkManagedChannel,
  resolveBkManagedEnvironment,
} from "./bk-managed-environment.ts";

describe("resolveBkManagedEnvironment", () => {
  it("is unset for an ordinary build", () => {
    expect(resolveBkManagedEnvironment({})).toBeUndefined();
    expect(resolveBkManagedEnvironment({ [BK_MANAGED_CHANNEL_ENV_VAR]: "" })).toBeUndefined();
    expect(resolveBkManagedEnvironment({ [BK_MANAGED_CHANNEL_ENV_VAR]: "   " })).toBeUndefined();
  });

  it("resolves staging to expbkt3", () => {
    expect(resolveBkManagedEnvironment({ [BK_MANAGED_CHANNEL_ENV_VAR]: "staging" })).toEqual({
      channel: "staging",
      httpBaseUrl: "https://expbkt3.dev.beknown.live",
      wsBaseUrl: "wss://expbkt3.dev.beknown.live",
    });
  });

  it("resolves production to bkt3", () => {
    expect(resolveBkManagedEnvironment({ [BK_MANAGED_CHANNEL_ENV_VAR]: "PRODUCTION" })).toEqual({
      channel: "production",
      httpBaseUrl: "https://bkt3.dev.beknown.live",
      wsBaseUrl: "wss://bkt3.dev.beknown.live",
    });
  });

  it("rejects an unknown channel instead of silently building a local-only app", () => {
    expect(() => resolveBkManagedEnvironment({ [BK_MANAGED_CHANNEL_ENV_VAR]: "prod" })).toThrow(
      /must be one of/,
    );
  });

  it("pairs every channel's websocket URL with its HTTP URL", () => {
    for (const environment of Object.values(BK_MANAGED_ENVIRONMENTS)) {
      expect(environment.httpBaseUrl.startsWith("https://")).toBe(true);
      expect(environment.wsBaseUrl).toBe(environment.httpBaseUrl.replace(/^https:/u, "wss:"));
      expect(isBkManagedChannel(environment.channel)).toBe(true);
    }
  });
});
