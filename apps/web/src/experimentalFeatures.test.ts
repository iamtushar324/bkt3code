import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("experimental feature build flags", () => {
  it("enables the control center from its build flag", async () => {
    vi.stubEnv("VITE_T3_EXPERIMENTAL_CONTROL_CENTER", "true");

    const flags = await import("./experimentalFeatures");

    expect(flags.EXPERIMENTAL_CONTROL_CENTER_ENABLED).toBe(true);
  });

  it("keeps the control center disabled when its build flag is false", async () => {
    vi.stubEnv("VITE_T3_EXPERIMENTAL_CONTROL_CENTER", "false");

    const flags = await import("./experimentalFeatures");

    expect(flags.EXPERIMENTAL_CONTROL_CENTER_ENABLED).toBe(false);
  });
});
