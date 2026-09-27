import { afterEach, describe, expect, it } from "@effect/vitest";

import { readPrimaryEnvironmentTarget } from "../environments/primary/target";
import {
  __resetBkManagedEnvironmentForTests,
  __setBkManagedEnvironmentForTests,
  bkPrimaryRegistrationCacheKey,
  isBkManagedPrimary,
  parseBkManagedEnvironment,
  readBkManagedPrimaryEnvironmentTarget,
} from "./managedEnvironment";

const STAGING = {
  channel: "staging",
  httpBaseUrl: "https://expbkt3.dev.beknown.live",
  wsBaseUrl: "wss://expbkt3.dev.beknown.live",
} as const;

const PRODUCTION = {
  channel: "production",
  httpBaseUrl: "https://bkt3.dev.beknown.live",
  wsBaseUrl: "wss://bkt3.dev.beknown.live",
} as const;

function stubWindow(origin: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: `${origin}/`, origin } },
  });
}

describe("parseBkManagedEnvironment", () => {
  it("accepts a complete managed environment", () => {
    expect(parseBkManagedEnvironment(STAGING)).toEqual(STAGING);
    expect(parseBkManagedEnvironment(PRODUCTION)).toEqual(PRODUCTION);
  });

  it("reads anything malformed or absent as unmanaged", () => {
    expect(parseBkManagedEnvironment(null)).toBeNull();
    expect(parseBkManagedEnvironment(undefined)).toBeNull();
    expect(parseBkManagedEnvironment("staging")).toBeNull();
    expect(parseBkManagedEnvironment({ ...STAGING, channel: "nightly" })).toBeNull();
    expect(parseBkManagedEnvironment({ ...STAGING, httpBaseUrl: "" })).toBeNull();
    expect(parseBkManagedEnvironment({ channel: "staging" })).toBeNull();
  });
});

describe("managed primary target", () => {
  afterEach(() => {
    __resetBkManagedEnvironmentForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("is absent in an upstream (non-managed) build", () => {
    expect(isBkManagedPrimary()).toBe(false);
    expect(readBkManagedPrimaryEnvironmentTarget()).toBeNull();
  });

  it("resolves per channel", () => {
    __setBkManagedEnvironmentForTests(STAGING);
    expect(readBkManagedPrimaryEnvironmentTarget()).toEqual({
      source: "configured",
      target: { httpBaseUrl: STAGING.httpBaseUrl, wsBaseUrl: STAGING.wsBaseUrl },
    });

    __setBkManagedEnvironmentForTests(PRODUCTION);
    expect(readBkManagedPrimaryEnvironmentTarget()).toEqual({
      source: "configured",
      target: { httpBaseUrl: PRODUCTION.httpBaseUrl, wsBaseUrl: PRODUCTION.wsBaseUrl },
    });
  });

  it("outranks every other primary target resolution in a managed build", () => {
    stubWindow("http://127.0.0.1:3773");
    __setBkManagedEnvironmentForTests(PRODUCTION);

    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "configured",
      target: { httpBaseUrl: PRODUCTION.httpBaseUrl, wsBaseUrl: PRODUCTION.wsBaseUrl },
    });
  });

  it("leaves an upstream build resolving exactly as before", () => {
    stubWindow("http://127.0.0.1:3773");

    expect(readPrimaryEnvironmentTarget()).toEqual({
      source: "window-origin",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    });
  });
});

describe("bkPrimaryRegistrationCacheKey", () => {
  afterEach(() => {
    __resetBkManagedEnvironmentForTests();
  });

  it("keeps the upstream local-backend id for an unmanaged build", () => {
    expect(bkPrimaryRegistrationCacheKey("primary")).toBe("primary");
  });

  it("moves the primary to its own slot so the bundled backend keeps 'primary'", () => {
    __setBkManagedEnvironmentForTests(STAGING);
    expect(bkPrimaryRegistrationCacheKey("primary")).not.toBe("primary");
  });
});
