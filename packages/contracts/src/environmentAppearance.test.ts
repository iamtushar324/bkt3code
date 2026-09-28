// T3-CUSTOM(expbkt3): the shared host appearance server setting.
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("ServerSettings environmentAppearance", () => {
  it("defaults to null", () => {
    expect(decodeServerSettings({}).environmentAppearance).toBeNull();
  });

  it("round-trips through encode", () => {
    const appearance = { nickname: "Build box", iconId: "rocket", colorId: "teal" };
    const settings = decodeServerSettings({ environmentAppearance: appearance });
    expect(settings.environmentAppearance).toEqual(appearance);
    expect(encodeServerSettings(settings).environmentAppearance).toEqual(appearance);
    expect(decodeServerSettings(encodeServerSettings(settings)).environmentAppearance).toEqual(
      appearance,
    );
  });

  it("trims the nickname", () => {
    expect(
      decodeServerSettings({ environmentAppearance: { nickname: "  Lab  " } })
        .environmentAppearance,
    ).toEqual({ nickname: "Lab" });
  });

  it("keeps an icon or colour id this build does not know", () => {
    // Catalogues belong to the clients; an older one falls back to its derived look.
    expect(
      decodeServerSettings({ environmentAppearance: { iconId: "toaster", colorId: "mauve" } })
        .environmentAppearance,
    ).toEqual({ iconId: "toaster", colorId: "mauve" });
  });

  it("decodes a malformed value as null instead of failing the snapshot", () => {
    for (const environmentAppearance of [
      "rocket",
      { nickname: "x".repeat(41) },
      { nickname: "   " },
      { iconId: 3 },
    ]) {
      const settings = decodeServerSettings({ environmentAppearance, environmentIcon: "laptop" });
      expect(settings.environmentAppearance).toBeNull();
      expect(settings.environmentIcon).toBe("laptop");
    }
  });
});

describe("ServerSettingsPatch environmentAppearance", () => {
  it("accepts a whole appearance and null to reset", () => {
    expect(
      decodeServerSettingsPatch({ environmentAppearance: { nickname: "Lab", colorId: "pink" } }),
    ).toEqual({ environmentAppearance: { nickname: "Lab", colorId: "pink" } });
    expect(decodeServerSettingsPatch({ environmentAppearance: null })).toEqual({
      environmentAppearance: null,
    });
    expect(decodeServerSettingsPatch({})).toEqual({});
  });

  it("rejects a nickname over the limit", () => {
    expect(() =>
      decodeServerSettingsPatch({ environmentAppearance: { nickname: "x".repeat(41) } }),
    ).toThrow();
  });
});
