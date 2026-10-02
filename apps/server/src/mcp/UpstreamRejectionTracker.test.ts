import { describe, expect, it } from "vite-plus/test";

import { makeUpstreamRejectionTracker, rejectionKey } from "./UpstreamRejectionTracker.ts";

const MINUTE = 60_000;
const makeTracker = () => makeUpstreamRejectionTracker({ threshold: 2, windowMs: 10 * MINUTE });
const key = rejectionKey("user_1", "ty_token_a");

describe("rejectionKey", () => {
  it("names a user's credential without keeping the credential", () => {
    expect(key).not.toContain("ty_token_a");
    expect(key.startsWith("user_1:")).toBe(true);
    expect(rejectionKey("user_1", "ty_token_a")).toBe(key);
    expect(rejectionKey("user_1", "ty_token_b")).not.toBe(key);
    expect(rejectionKey("user_2", "ty_token_a")).not.toBe(key);
  });
});

describe("makeUpstreamRejectionTracker", () => {
  it("trips on the second consecutive rejection, then starts over", () => {
    const tracker = makeTracker();
    expect(tracker.recordRejection(key, 0)).toBe(false);
    expect(tracker.recordRejection(key, 1_000)).toBe(true);
    expect(tracker.size()).toBe(0);
    // The token was retired; whatever comes next is a first strike again.
    expect(tracker.recordRejection(key, 2_000)).toBe(false);
  });

  it("forgets a strike once a call is accepted", () => {
    const tracker = makeTracker();
    expect(tracker.recordRejection(key, 0)).toBe(false);
    tracker.recordAcceptance(key);
    expect(tracker.size()).toBe(0);
    expect(tracker.recordRejection(key, 1_000)).toBe(false);
    expect(tracker.recordRejection(key, 2_000)).toBe(true);
  });

  it("forgets a strike older than the window", () => {
    const tracker = makeTracker();
    expect(tracker.recordRejection(key, 0)).toBe(false);
    expect(tracker.recordRejection(key, 10 * MINUTE + 1)).toBe(false);
    expect(tracker.recordRejection(key, 10 * MINUTE + 2)).toBe(true);
  });

  it("keeps strikes apart per user and per credential", () => {
    const tracker = makeTracker();
    const otherCredential = rejectionKey("user_1", "ty_token_b");
    const otherUser = rejectionKey("user_2", "ty_token_a");
    expect(tracker.recordRejection(key, 0)).toBe(false);
    expect(tracker.recordRejection(otherCredential, 0)).toBe(false);
    expect(tracker.recordRejection(otherUser, 0)).toBe(false);
    expect(tracker.size()).toBe(3);
    expect(tracker.recordRejection(key, 1)).toBe(true);
    expect(tracker.size()).toBe(2);
  });

  it("drops expired strikes of other credentials as it goes", () => {
    const tracker = makeTracker();
    const stale = rejectionKey("user_3", "ty_old");
    tracker.recordRejection(stale, 0);
    tracker.recordRejection(key, 11 * MINUTE);
    expect(tracker.size()).toBe(1);
  });
});
