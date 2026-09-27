import { describe, expect, it } from "vite-plus/test";

import { shouldUsePhaseGroupedSidebar } from "./sidebarVariant";

describe("phase sidebar variant selection", () => {
  it("waits for settings hydration and honors the experiment flag", () => {
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: false,
        phaseGroupedSidebarEnabled: true,
        pathname: "/environment/thread",
      }),
    ).toBe(false);
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: true,
        phaseGroupedSidebarEnabled: false,
        pathname: "/environment/thread",
      }),
    ).toBe(false);
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: true,
        phaseGroupedSidebarEnabled: true,
        pathname: "/environment/thread",
      }),
    ).toBe(true);
  });

  it("keeps the repository sidebar on every settings route", () => {
    expect(
      shouldUsePhaseGroupedSidebar({
        clientSettingsHydrated: true,
        phaseGroupedSidebarEnabled: true,
        pathname: "/settings/experiments",
      }),
    ).toBe(false);
  });
});
