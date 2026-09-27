import { describe, expect, it } from "vite-plus/test";

import {
  FOCUS_RESYNC_AFTER_MS,
  makeFocusWakeupTracker,
  makeReturnWakeupCoalescer,
  RETURN_COALESCE_MS,
} from "./focusWakeup.expbkt3";

const trackerAt = () => {
  let nowMs = 1_000_000;
  const tracker = makeFocusWakeupTracker(() => nowMs);
  return { tracker, advance: (ms: number) => (nowMs += ms) };
};

describe("focus wakeups", () => {
  it("only probes on a quick alt-tab", () => {
    const { tracker, advance } = trackerAt();
    tracker.markInactive();
    advance(5_000);
    expect(tracker.onFocus()).toBe("application-focus");
  });

  it("resyncs after the window was away for a minute", () => {
    const { tracker, advance } = trackerAt();
    tracker.markInactive();
    advance(FOCUS_RESYNC_AFTER_MS / 2);
    // A second blur (another window) does not restart the absence.
    tracker.markInactive();
    advance(FOCUS_RESYNC_AFTER_MS / 2);
    expect(tracker.onFocus()).toBe("application-active");
    // The return was consumed; an immediate refocus only probes.
    expect(tracker.onFocus()).toBe("application-focus");
  });

  it("does not resync twice when visibility already did", () => {
    const { tracker, advance } = trackerAt();
    tracker.markInactive();
    advance(10 * FOCUS_RESYNC_AFTER_MS);
    tracker.markResynced();
    expect(tracker.onFocus()).toBe("application-focus");
  });

  it("probes a focus with no recorded absence", () => {
    expect(trackerAt().tracker.onFocus()).toBe("application-focus");
  });
});

describe("return wakeup coalescing", () => {
  const coalescerAt = () => {
    let nowMs = 1_000_000;
    const coalesce = makeReturnWakeupCoalescer(() => nowMs);
    return { coalesce, advance: (ms: number) => (nowMs += ms) };
  };

  it("resyncs once when focus and visibility both report the same return", () => {
    const { coalesce, advance } = coalescerAt();
    expect(coalesce("application-active")).toBe("application-active");
    advance(2_000);
    expect(coalesce("application-active")).toBe("application-focus");
  });

  it("does not resync right after a reconnect already resubscribed", () => {
    const { coalesce, advance } = coalescerAt();
    expect(coalesce("application-active-reconnect")).toBe("application-active-reconnect");
    advance(1_000);
    expect(coalesce("application-active")).toBe("application-focus");
    // A reconnect is never downgraded: only a new socket fixes a dead one.
    expect(coalesce("application-active-reconnect")).toBe("application-active-reconnect");
  });

  it("resyncs again on a later, separate return", () => {
    const { coalesce, advance } = coalescerAt();
    expect(coalesce("application-active")).toBe("application-active");
    advance(RETURN_COALESCE_MS);
    expect(coalesce("application-active")).toBe("application-active");
  });

  it("passes probes and credential changes through untouched", () => {
    const { coalesce } = coalescerAt();
    expect(coalesce("application-active")).toBe("application-active");
    expect(coalesce("application-focus")).toBe("application-focus");
    expect(coalesce("credentials-changed")).toBe("credentials-changed");
  });
});
