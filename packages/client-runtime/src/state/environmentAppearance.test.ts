// T3-CUSTOM(expbkt3): the shared environment identity catalogue.
import { describe, expect, it } from "vite-plus/test";

import {
  defaultEnvironmentColorId,
  defaultEnvironmentIconId,
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_DESCRIPTORS,
  environmentAppearanceFromSettings,
  environmentAppearanceSettingValue,
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

describe("host appearance from server settings", () => {
  it("uses the host's setting as the override and falls back when it is null", () => {
    const shared = environmentAppearanceFromSettings({
      environmentAppearance: { nickname: "Build box", iconId: "rocket", colorId: "pink" },
    });
    expect(
      resolveEnvironmentIdentity({ environmentId: ENV_A, label: "dev-1", appearance: shared }),
    ).toMatchObject({
      name: "Build box",
      iconId: "rocket",
      colorId: "pink",
      customized: true,
    });

    for (const settings of [{ environmentAppearance: null }, {}, null, undefined]) {
      expect(
        resolveEnvironmentIdentity({
          environmentId: ENV_A,
          label: "dev-1",
          appearance: environmentAppearanceFromSettings(settings),
        }),
      ).toMatchObject({
        name: "dev-1",
        iconId: defaultEnvironmentIconId(ENV_A),
        colorId: defaultEnvironmentColorId(ENV_A),
        customized: false,
      });
    }
  });

  it("keeps the connection label when the host sets only an icon", () => {
    expect(
      resolveEnvironmentIdentity({
        environmentId: ENV_B,
        label: "dev-2",
        appearance: environmentAppearanceFromSettings({
          environmentAppearance: { iconId: "cloud" },
        }),
      }),
    ).toMatchObject({ name: "dev-2", iconId: "cloud", customized: true, glyphCustomized: true });
    expect(
      resolveEnvironmentIdentity({
        environmentId: ENV_B,
        label: "dev-2",
        appearance: { nickname: "Lab" },
      }),
    ).toMatchObject({ name: "Lab", customized: true, glyphCustomized: false });
  });

  it("derives an icon for an id a newer client wrote", () => {
    const resolved = resolveEnvironmentIdentity({
      environmentId: ENV_A,
      label: "x",
      appearance: { iconId: "toaster", colorId: "teal" },
    });
    expect(ENVIRONMENT_ICON_DESCRIPTORS.some((o) => o.id === resolved.iconId)).toBe(true);
    expect(resolved.colorId).toBe("teal");
  });
});

describe("environmentAppearanceSettingValue", () => {
  it("writes only known ids and a trimmed, bounded nickname", () => {
    expect(
      environmentAppearanceSettingValue({ nickname: `  ${"n".repeat(60)}`, iconId: "nope" }),
    ).toEqual({ nickname: "n".repeat(40) });
    expect(environmentAppearanceSettingValue({ iconId: "cloud", colorId: "teal" })).toEqual({
      iconId: "cloud",
      colorId: "teal",
    });
  });

  it("resets to null when nothing is left", () => {
    expect(environmentAppearanceSettingValue({ nickname: "   " })).toBeNull();
    expect(environmentAppearanceSettingValue({})).toBeNull();
  });
});
