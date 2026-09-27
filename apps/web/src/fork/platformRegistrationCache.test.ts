import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import {
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  __resetPersistedPrimaryRegistrationForTests,
  clearPersistedPrimaryRegistration,
  parseStoredPlatformRegistration,
  platformRegistrationFromStored,
  primaryRegistrationFallback,
  readPersistedPrimaryRegistration,
  storedPlatformRegistration,
  writePersistedPrimaryRegistration,
} from "./platformRegistrationCache";

const SIGNATURE = "primary|https://bkt3.dev.beknown.live|wss://bkt3.dev.beknown.live";

const STORED = {
  signature: SIGNATURE,
  environmentId: "env-bkt3",
  label: "bkt3",
  httpBaseUrl: "https://bkt3.dev.beknown.live",
  wsBaseUrl: "wss://bkt3.dev.beknown.live",
} as const;

function registration(): PrimaryConnectionRegistration {
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: "env-bkt3" as EnvironmentId,
      label: "bkt3",
      httpBaseUrl: "https://bkt3.dev.beknown.live",
      wsBaseUrl: "wss://bkt3.dev.beknown.live",
    }),
  });
}

// These specs run without a DOM, so stand in a minimal storage to exercise the
// persisted path the browser takes rather than only the in-memory mirror.
function stubStorage(): void {
  const values = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    },
  };
}

beforeEach(() => {
  stubStorage();
  __resetPersistedPrimaryRegistrationForTests();
});

afterEach(() => {
  __resetPersistedPrimaryRegistrationForTests();
  delete (globalThis as { window?: unknown }).window;
});

describe("parseStoredPlatformRegistration", () => {
  it("accepts a complete record", () => {
    expect(parseStoredPlatformRegistration(JSON.stringify(STORED))).toEqual(STORED);
  });

  it("rejects malformed, empty, and incomplete records", () => {
    expect(parseStoredPlatformRegistration(null)).toBeNull();
    expect(parseStoredPlatformRegistration("not json")).toBeNull();
    expect(
      parseStoredPlatformRegistration(JSON.stringify({ ...STORED, signature: "" })),
    ).toBeNull();
    expect(
      parseStoredPlatformRegistration(JSON.stringify({ ...STORED, httpBaseUrl: undefined })),
    ).toBeNull();
  });
});

describe("primaryRegistrationFallback", () => {
  it("reinstates the environment the host last reported", () => {
    const fallback = primaryRegistrationFallback(SIGNATURE, STORED);
    expect(fallback?.target.environmentId).toBe("env-bkt3");
    expect(fallback?.target.label).toBe("bkt3");
    expect(fallback?.target.wsBaseUrl).toBe("wss://bkt3.dev.beknown.live");
  });

  it("refuses a record resolved for different endpoints", () => {
    expect(
      primaryRegistrationFallback("primary|https://other.example|wss://other.example", STORED),
    ).toBeNull();
  });

  it("has nothing to offer before a first successful resolve", () => {
    expect(primaryRegistrationFallback(SIGNATURE, null)).toBeNull();
  });
});

describe("persistence round trip", () => {
  it("survives a restart and rebuilds the same registration", () => {
    writePersistedPrimaryRegistration(storedPlatformRegistration(SIGNATURE, registration()));
    __resetPersistedPrimaryRegistrationForTests();

    const restored = readPersistedPrimaryRegistration();
    expect(restored).toEqual(STORED);
    expect(platformRegistrationFromStored(restored!).target.environmentId).toBe("env-bkt3");
  });

  it("clears the record on request", () => {
    writePersistedPrimaryRegistration(STORED);
    clearPersistedPrimaryRegistration();
    __resetPersistedPrimaryRegistrationForTests();
    expect(readPersistedPrimaryRegistration()).toBeNull();
  });
});
