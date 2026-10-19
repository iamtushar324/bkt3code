import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveClientAnalyticsConfig } from "./clientAnalyticsConfig.ts";

const base = {
  posthogKey: Option.some("phc_company"),
  posthogHost: Option.none<string>(),
  enabled: true,
  instance: Option.some("bkt3"),
};

describe("resolveClientAnalyticsConfig", () => {
  it("advertises an explicit key with the default host and the instance", () => {
    expect(resolveClientAnalyticsConfig(base)).toEqual({
      enabled: true,
      posthogKey: "phc_company",
      posthogHost: "https://us.i.posthog.com",
      instance: "bkt3",
    });
  });

  it("stays absent without an explicit key, so clients never use upstream's project", () => {
    expect(resolveClientAnalyticsConfig({ ...base, posthogKey: Option.none() })).toBeNull();
    expect(resolveClientAnalyticsConfig({ ...base, posthogKey: Option.some("  ") })).toBeNull();
  });

  it("stays absent when telemetry is off", () => {
    expect(resolveClientAnalyticsConfig({ ...base, enabled: false })).toBeNull();
  });

  it("omits a blank instance and honours a custom host", () => {
    expect(
      resolveClientAnalyticsConfig({
        ...base,
        instance: Option.some(""),
        posthogHost: Option.some("https://eu.i.posthog.com"),
      }),
    ).toEqual({
      enabled: true,
      posthogKey: "phc_company",
      posthogHost: "https://eu.i.posthog.com",
    });
  });
});
