/**
 * T3-CUSTOM(expbkt3): per-environment identity resolution.
 *
 * The load-bearing property is that two environments look different *before*
 * anyone configures them — an operator who attaches a second machine and sees two
 * identical grey badges is no better off than before.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  defaultEnvironmentColorId,
  defaultEnvironmentIconId,
  ENVIRONMENT_COLOR_OPTIONS,
  ENVIRONMENT_ICON_OPTIONS,
  resolveEnvironmentAppearance,
  sanitizeEnvironmentAppearance,
} from "./environmentAppearance";

const ENV_A = "0fcaa930-fe3c-4991-9882-2188cde8b928";
const ENV_B = "56ea1b63-2cc0-4cb9-bb6f-4b40d6ab510d";

describe("environment appearance defaults", () => {
  it("derives a stable colour and icon from the environment id", () => {
    expect(defaultEnvironmentColorId(ENV_A)).toBe(defaultEnvironmentColorId(ENV_A));
    expect(defaultEnvironmentIconId(ENV_A)).toBe(defaultEnvironmentIconId(ENV_A));
  });

  it("always derives a value that exists in the catalogue", () => {
    for (const id of [ENV_A, ENV_B, "", "x"]) {
      expect(ENVIRONMENT_COLOR_OPTIONS.some((o) => o.id === defaultEnvironmentColorId(id))).toBe(
        true,
      );
      expect(ENVIRONMENT_ICON_OPTIONS.some((o) => o.id === defaultEnvironmentIconId(id))).toBe(
        true,
      );
    }
  });

  it("gives the two real environments distinct colours without configuration", () => {
    expect(defaultEnvironmentColorId(ENV_A)).not.toBe(defaultEnvironmentColorId(ENV_B));
  });
});

describe("resolveEnvironmentAppearance", () => {
  it("falls back to the connection label when no nickname is set", () => {
    const resolved = resolveEnvironmentAppearance({
      environmentId: ENV_A,
      label: "ip-10-31-39-131",
    });
    expect(resolved.name).toBe("ip-10-31-39-131");
    expect(resolved.customized).toBe(false);
  });

  it("prefers the nickname over the connection label", () => {
    const resolved = resolveEnvironmentAppearance({
      environmentId: ENV_A,
      label: "ip-10-31-39-131",
      appearance: { nickname: "Staging box" },
    });
    expect(resolved.name).toBe("Staging box");
    expect(resolved.customized).toBe(true);
  });

  it("treats a whitespace-only nickname as unset rather than an empty badge", () => {
    const resolved = resolveEnvironmentAppearance({
      environmentId: ENV_A,
      label: "ip-10-31-39-131",
      appearance: { nickname: "   " },
    });
    expect(resolved.name).toBe("ip-10-31-39-131");
  });

  it("keeps the derived look for whichever field was not customised", () => {
    const derivedIcon = defaultEnvironmentIconId(ENV_A);
    const resolved = resolveEnvironmentAppearance({
      environmentId: ENV_A,
      label: "box",
      appearance: { colorId: "pink" },
    });
    expect(resolved.colorId).toBe("pink");
    expect(resolved.iconId).toBe(derivedIcon);
  });

  it("ignores an unknown icon or colour rather than rendering nothing", () => {
    const resolved = resolveEnvironmentAppearance({
      environmentId: ENV_A,
      label: "box",
      appearance: { iconId: "not-a-real-icon", colorId: "not-a-real-colour" },
    });
    expect(ENVIRONMENT_ICON_OPTIONS.some((o) => o.id === resolved.iconId)).toBe(true);
    expect(ENVIRONMENT_COLOR_OPTIONS.some((o) => o.id === resolved.colorId)).toBe(true);
  });
});

describe("sanitizeEnvironmentAppearance", () => {
  it("drops an appearance with nothing set, so it is not stored forever", () => {
    expect(sanitizeEnvironmentAppearance({})).toBeNull();
    expect(sanitizeEnvironmentAppearance({ nickname: "  " })).toBeNull();
  });

  it("drops values outside the catalogue", () => {
    expect(sanitizeEnvironmentAppearance({ iconId: "nope", colorId: "nope" })).toBeNull();
  });

  it("keeps a valid subset", () => {
    expect(
      sanitizeEnvironmentAppearance({ nickname: " Prod ", colorId: "teal", iconId: "nope" }),
    ).toEqual({ nickname: "Prod", colorId: "teal" });
  });

  it("rejects non-objects from a corrupted storage blob", () => {
    expect(sanitizeEnvironmentAppearance(null)).toBeNull();
    expect(sanitizeEnvironmentAppearance("prod")).toBeNull();
  });
});
