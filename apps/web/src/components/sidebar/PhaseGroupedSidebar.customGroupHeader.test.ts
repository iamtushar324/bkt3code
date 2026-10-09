// T3-CUSTOM(expbkt3): the custom-group header (XFN-59). Its actions float inside
// the pill instead of taking width beside it, and its colour is a tint.
import { describe, expect, it } from "vite-plus/test";

import {
  PHASE_SIDEBAR_SECTION_ACTION_BUTTON_CLASS_NAME,
  PHASE_SIDEBAR_SECTION_MANAGED_HEADER_CLASS_NAME,
  phaseSidebarCustomGroupAccentStyle,
  phaseSidebarSectionActionsClassName,
  phaseSidebarSectionHeaderClassName,
} from "./PhaseGroupedSidebar.logic";

const classes = (value: string) => value.split(/\s+/);

describe("custom group header actions", () => {
  it("positions the actions over the pill, so they take no layout width", () => {
    const wrapper = classes(PHASE_SIDEBAR_SECTION_MANAGED_HEADER_CLASS_NAME);
    expect(wrapper).toContain("relative");
    expect(wrapper).toContain("group/section");
    // The wrapper takes over the pill's bottom margin, so it ends where the pill does.
    expect(wrapper).toContain("mb-1.5");
    expect(classes(phaseSidebarSectionHeaderClassName(null))).toContain("mb-1.5");

    const actions = classes(phaseSidebarSectionActionsClassName(false));
    expect(actions).toContain("absolute");
    expect(actions).toContain("right-1");
    expect(actions).not.toContain("shrink-0");
  });

  it("hides the actions until hover or keyboard focus, and keeps them while a picker is open", () => {
    const closed = classes(phaseSidebarSectionActionsClassName(false));
    expect(closed).toContain("hidden");
    expect(closed).toContain("group-hover/section:flex");
    expect(closed).toContain("group-has-[:focus-visible]/section:flex");

    const open = classes(phaseSidebarSectionActionsClassName(true));
    expect(open).toContain("flex");
    expect(open).not.toContain("hidden");
  });

  it("shows a keyboard focus ring on each action", () => {
    expect(classes(PHASE_SIDEBAR_SECTION_ACTION_BUTTON_CLASS_NAME)).toContain(
      "focus-visible:ring-1",
    );
  });
});

describe("phaseSidebarCustomGroupAccentStyle", () => {
  it("keeps the neutral look without a colour", () => {
    expect(phaseSidebarCustomGroupAccentStyle(null)).toBeUndefined();
    expect(phaseSidebarCustomGroupAccentStyle(undefined)).toBeUndefined();
  });

  it("tints the border and surface from the group's colour", () => {
    expect(phaseSidebarCustomGroupAccentStyle("#3b82f6")).toEqual({
      borderColor: "color-mix(in srgb, #3b82f6 45%, transparent)",
      backgroundColor: "color-mix(in srgb, #3b82f6 12%, transparent)",
    });
  });
});
