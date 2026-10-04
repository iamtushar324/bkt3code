import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

// T3-CUSTOM(expbkt3): Opt-in plan submission must apply to existing installations too.
describe("plan submission tool experiment", () => {
  it("defaults to disabled for fresh and legacy settings", () => {
    expect(DEFAULT_SERVER_SETTINGS.experimental.agentPlanSubmissionEnabled).toBe(false);
    expect(decodeSettings({}).experimental.agentPlanSubmissionEnabled).toBe(false);
    expect(
      decodeSettings({ experimental: { externalMcp: { enabled: true } } }).experimental
        .agentPlanSubmissionEnabled,
    ).toBe(false);
  });

  it.each([true, false])("round-trips an explicit %s value and its patch", (enabled) => {
    const input = { experimental: { agentPlanSubmissionEnabled: enabled } };
    const settings = decodeSettings(input);
    expect(encodeSettings(settings)).toMatchObject(input);
    expect(decodePatch(input)).toEqual(input);
  });

  it("rejects a non-Boolean value", () => {
    const input = { experimental: { agentPlanSubmissionEnabled: "false" } };
    expect(() => decodeSettings(input)).toThrow();
    expect(() => decodePatch(input)).toThrow();
  });
});
