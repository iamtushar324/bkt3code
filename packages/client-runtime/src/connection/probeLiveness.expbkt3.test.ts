import { describe, expect, it } from "@effect/vitest";

import {
  PROBE_TIMEOUT_RECONNECT_JITTER_MAX_MS,
  probeTimeoutOutcome,
  probeTimeoutReconnectJitterMs,
} from "./probeLiveness.expbkt3.ts";

describe("probeTimeoutOutcome", () => {
  it("keeps a session that received frames during the probe, and restarts the silent count", () => {
    expect(
      probeTimeoutOutcome({ framesDuringProbe: true, silentTimeoutsBefore: 1, decisive: true }),
    ).toEqual({ _tag: "Degraded", silentTimeouts: 0 });
  });

  it("gives a silent session one more probe", () => {
    expect(
      probeTimeoutOutcome({ framesDuringProbe: false, silentTimeoutsBefore: 0, decisive: false }),
    ).toEqual({ _tag: "Degraded", silentTimeouts: 1 });
  });

  it("ends a session after two silent probes in a row", () => {
    expect(
      probeTimeoutOutcome({ framesDuringProbe: false, silentTimeoutsBefore: 1, decisive: false }),
    ).toEqual({ _tag: "TearDown" });
  });

  it("ends a silent session at once after a network path change", () => {
    expect(
      probeTimeoutOutcome({ framesDuringProbe: false, silentTimeoutsBefore: 0, decisive: true }),
    ).toEqual({ _tag: "TearDown" });
  });
});

describe("probeTimeoutReconnectJitterMs", () => {
  it("stays within 0-2 s", () => {
    expect(probeTimeoutReconnectJitterMs(0)).toBe(0);
    expect(probeTimeoutReconnectJitterMs(0.5)).toBe(1_000);
    expect(probeTimeoutReconnectJitterMs(1 - Number.EPSILON)).toBe(
      PROBE_TIMEOUT_RECONNECT_JITTER_MAX_MS,
    );
    expect(probeTimeoutReconnectJitterMs(-1)).toBe(0);
    expect(probeTimeoutReconnectJitterMs(2)).toBe(PROBE_TIMEOUT_RECONNECT_JITTER_MAX_MS);
  });
});
