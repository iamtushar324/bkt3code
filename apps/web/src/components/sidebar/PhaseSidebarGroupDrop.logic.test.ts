// T3-CUSTOM(expbkt3): which drops of a session on a section write a group.
import { describe, expect, it } from "vite-plus/test";

import {
  resolvePhaseSidebarRowDrop,
  type PhaseSidebarRowDropSection,
} from "./PhaseSidebarGroupDrop.logic";

const group = (label: string): PhaseSidebarRowDropSection => ({
  kind: "custom",
  id: label.toLowerCase(),
  isUngrouped: false,
  label,
});
const UNGROUPED: PhaseSidebarRowDropSection = {
  kind: "custom",
  id: "ungrouped",
  isUngrouped: true,
  label: "Ungrouped",
};

describe("resolvePhaseSidebarRowDrop", () => {
  it("files a session in another group under the header's label", () => {
    expect(resolvePhaseSidebarRowDrop("Sprint 41", group("Sprint 42"))).toEqual({
      customGroup: "Sprint 42",
    });
    expect(resolvePhaseSidebarRowDrop(null, group("Sprint 42"))).toEqual({
      customGroup: "Sprint 42",
    });
  });

  it("refuses a drop on the session's own group, whatever its spelling", () => {
    expect(resolvePhaseSidebarRowDrop("sprint  42", group("Sprint 42"))).toBeNull();
    expect(resolvePhaseSidebarRowDrop("Sprint 42", group("Sprint 42"))).toBeNull();
  });

  it("takes a grouped session out of its group on Ungrouped, and refuses an ungrouped one", () => {
    expect(resolvePhaseSidebarRowDrop("Sprint 42", UNGROUPED)).toEqual({ customGroup: null });
    expect(resolvePhaseSidebarRowDrop(null, UNGROUPED)).toBeNull();
    expect(resolvePhaseSidebarRowDrop(undefined, UNGROUPED)).toBeNull();
  });

  it("refuses sections that are not custom groups", () => {
    expect(
      resolvePhaseSidebarRowDrop(null, {
        kind: "lifecycle",
        id: "ready",
        isUngrouped: false,
        label: "Ready",
      }),
    ).toBeNull();
    expect(
      resolvePhaseSidebarRowDrop(null, { kind: "custom", id: "", isUngrouped: false, label: " " }),
    ).toBeNull();
  });
});
