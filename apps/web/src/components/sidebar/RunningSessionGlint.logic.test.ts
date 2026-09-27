import { describe, expect, it } from "vite-plus/test";

import {
  isRunningSessionPhase,
  runningSessionDividerPhase,
  shouldShowRunningSessionGlint,
} from "./RunningSessionGlint.logic";

describe("shouldShowRunningSessionGlint", () => {
  it("shows the card glint only for active planning and implementation work", () => {
    expect(shouldShowRunningSessionGlint("planning", "active")).toBe(true);
    expect(shouldShowRunningSessionGlint("implementing", "active")).toBe(true);
    expect(shouldShowRunningSessionGlint("ready", "active")).toBe(false);
    expect(shouldShowRunningSessionGlint("needs_input", "active")).toBe(false);
    expect(shouldShowRunningSessionGlint("implementing", "snoozed")).toBe(false);
  });
});

describe("running session grouping", () => {
  it("identifies only live planning and implementation phases as running", () => {
    expect(isRunningSessionPhase("planning")).toBe(true);
    expect(isRunningSessionPhase("implementing")).toBe(true);
    expect(isRunningSessionPhase("ready")).toBe(false);
    expect(isRunningSessionPhase("needs_input")).toBe(false);
  });

  it("places one divider before the first running phase when idle work is visible", () => {
    expect(runningSessionDividerPhase(["ready", "planning", "implementing"])).toBe("planning");
    expect(runningSessionDividerPhase(["ready", "implementing"])).toBe("implementing");
    expect(runningSessionDividerPhase(["planning", "implementing"])).toBeNull();
    expect(runningSessionDividerPhase(["plan_ready", "ready"])).toBeNull();
  });
});
