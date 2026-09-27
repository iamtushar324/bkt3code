import { describe, expect, it } from "vite-plus/test";

import {
  PHASE_SIDEBAR_CONTENT_CLASS_NAME,
  PHASE_SIDEBAR_METADATA_CLASS_NAME,
} from "./PhaseSidebarRowLayout";

describe("phase sidebar row layout", () => {
  it("centers the title/metadata block and lets metadata wrap into a second line", () => {
    expect(PHASE_SIDEBAR_CONTENT_CLASS_NAME).toContain("self-stretch");
    expect(PHASE_SIDEBAR_CONTENT_CLASS_NAME).toContain("justify-center");
    expect(PHASE_SIDEBAR_METADATA_CLASS_NAME).toContain("flex-wrap");
  });
});
