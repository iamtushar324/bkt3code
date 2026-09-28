// T3-CUSTOM(expbkt3): who can edit a host's shared appearance.
import type { ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveEnvironmentAppearanceLock } from "./EnvironmentAppearanceEditor.logic";

const config = (environmentAppearance: boolean | undefined) =>
  ({
    environment: {
      capabilities: environmentAppearance === undefined ? {} : { environmentAppearance },
    },
  }) as unknown as ServerConfig;

describe("resolveEnvironmentAppearanceLock", () => {
  it("locks until the environment is connected", () => {
    expect(
      resolveEnvironmentAppearanceLock({ serverConfig: null, operateAccess: "granted" }),
    ).toMatch(/Connect/);
  });

  it("locks on servers that would drop the setting, before looking at permissions", () => {
    expect(
      resolveEnvironmentAppearanceLock({
        serverConfig: config(undefined),
        operateAccess: "denied",
      }),
    ).toMatch(/too old/);
  });

  it("locks when the session cannot operate the environment", () => {
    expect(
      resolveEnvironmentAppearanceLock({ serverConfig: config(true), operateAccess: "denied" }),
    ).toMatch(/cannot change/);
  });

  it("opens for an operator, and while access is still loading", () => {
    for (const operateAccess of ["granted", "pending"] as const) {
      expect(
        resolveEnvironmentAppearanceLock({ serverConfig: config(true), operateAccess }),
      ).toBeNull();
    }
  });
});
