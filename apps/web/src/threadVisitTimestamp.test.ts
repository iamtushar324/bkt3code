import { describe, expect, it } from "vite-plus/test";

import { resolveThreadVisitTimestamp } from "./threadVisitTimestamp";

describe("resolveThreadVisitTimestamp", () => {
  it("acknowledges a completed turn newer than the hydrated thread timestamp", () => {
    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-08-02T17:00:00.000Z",
        latestTurnCompletedAt: "2026-08-02T17:00:05.000Z",
      }),
    ).toBe("2026-08-02T17:00:05.000Z");
  });

  it("keeps a newer thread timestamp when completion is older or missing", () => {
    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-08-02T17:00:05.000Z",
        latestTurnCompletedAt: "2026-08-02T17:00:00.000Z",
      }),
    ).toBe("2026-08-02T17:00:05.000Z");
    expect(
      resolveThreadVisitTimestamp({
        threadUpdatedAt: "2026-08-02T17:00:05.000Z",
        latestTurnCompletedAt: null,
      }),
    ).toBe("2026-08-02T17:00:05.000Z");
  });
});
