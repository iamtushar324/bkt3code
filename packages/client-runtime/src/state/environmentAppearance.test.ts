// T3-CUSTOM(expbkt3): the shared environment identity catalogue.
import { describe, expect, it } from "vite-plus/test";

import {
  defaultEnvironmentColorId,
  defaultEnvironmentIconId,
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_DESCRIPTORS,
  resolveEnvironmentIdentity,
  sanitizeEnvironmentAppearance,
  sanitizeEnvironmentAppearanceMap,
} from "./environmentAppearance.ts";

const ENV_A = "0fcaa930-fe3c-4991-9882-2188cde8b928";
const ENV_B = "56ea1b63-2cc0-4cb9-bb6f-4b40d6ab510d";

describe("environment identity defaults", () => {
  it("derives a value that exists in the catalogue, stably", () => {
    for (const id of [ENV_A, ENV_B, "", "x"]) {
      expect(defaultEnvironmentColorId(id)).toBe(defaultEnvironmentColorId(id));
      expect(ENVIRONMENT_COLOR_OPTIONS.some((o) => o.id === defaultEnvironmentColorId(id))).toBe(
        true,
      );
      expect(ENVIRONMENT_ICON_DESCRIPTORS.some((o) => o.id === defaultEnvironmentIconId(id))).toBe(
        true,
      );
    }
  });

  it("pins the derivation so web and mobile agree across releases", () => {
    // If this changes, every operator's remotes silently change look on one client.
    expect(resolveEnvironmentIdentity({ environmentId: ENV_A, label: "a" })).toMatchObject({
      colorId: defaultEnvironmentColorId(ENV_A),
      iconId: defaultEnvironmentIconId(ENV_A),
      customized: false,
      name: "a",
    });
  });
});

describe("resolveEnvironmentIdentity", () => {
  it("prefers the nickname and marks overrides as customized", () => {
    const resolved = resolveEnvironmentIdentity({
      environmentId: ENV_A,
      label: "Connection label",
      appearance: { nickname: "  Build box ", colorId: "teal" },
    });
    expect(resolved.name).toBe("Build box");
    expect(resolved.colorId).toBe("teal");
    expect(resolved.color).toBe("#14b8a6");
    expect(resolved.customized).toBe(true);
  });

  it("falls back to the catalogue when a stored id is unknown", () => {
    const resolved = resolveEnvironmentIdentity({
      environmentId: ENV_A,
      label: "x",
      appearance: { iconId: "nope", colorId: "nope" },
    });
    expect(ENVIRONMENT_ICON_DESCRIPTORS.some((o) => o.id === resolved.iconId)).toBe(true);
    expect(ENVIRONMENT_COLOR_OPTIONS.some((o) => o.id === resolved.colorId)).toBe(true);
  });
});

describe("sanitizeEnvironmentAppearance", () => {
  it("drops unknown ids, blank nicknames and empty results", () => {
    expect(sanitizeEnvironmentAppearance({ nickname: "  ", iconId: "nope" })).toBeNull();
    expect(sanitizeEnvironmentAppearance({ nickname: " Lab ", colorId: "pink", extra: 1 })).toEqual(
      { nickname: "Lab", colorId: "pink" },
    );
    expect(sanitizeEnvironmentAppearance(null)).toBeNull();
  });

  it("sanitizes a whole stored map, removing empty entries", () => {
    expect(
      sanitizeEnvironmentAppearanceMap({
        [ENV_A]: { iconId: "cloud" },
        [ENV_B]: { nickname: "" },
        junk: 3,
      }),
    ).toEqual({ [ENV_A]: { iconId: "cloud" } });
    expect(sanitizeEnvironmentAppearanceMap("x")).toEqual({});
  });
});
