import { describe, expect, it } from "vite-plus/test";

import { shouldUsePhaseGroupedSidebar } from "./sidebarVariant";

describe("phase sidebar variant selection", () => {
  it("waits for settings hydration and honors the experiment flag", () => {
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: false,
        phaseGroupedSidebarEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: true,
        phaseGroupedSidebarEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: true,
        phaseGroupedSidebarEnabled: true,
      }),
    ).toBe(true);
  });
});
