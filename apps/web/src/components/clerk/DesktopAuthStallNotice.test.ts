import { describe, expect, it } from "vite-plus/test";

import { AUTH_STALL_TIMEOUT_MS, shouldReportAuthStall } from "./DesktopAuthStallNotice.tsx";

describe("shouldReportAuthStall", () => {
  it("reports a stall when the provider rendered nothing at all", () => {
    expect(shouldReportAuthStall(0)).toBe(true);
  });

  it("stays quiet whenever any app content rendered", () => {
    // A signed-out screen, a surfaced auth error and a loading spinner all put
    // elements in the root. None is a stall, and claiming otherwise would mask
    // the app's own error reporting.
    expect(shouldReportAuthStall(1)).toBe(false);
    expect(shouldReportAuthStall(5)).toBe(false);
  });

  it("stays quiet when the root element is missing rather than guessing", () => {
    expect(shouldReportAuthStall(undefined)).toBe(false);
  });

  it("waits long enough not to race a slow but working sign-in", () => {
    expect(AUTH_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
  });
});
