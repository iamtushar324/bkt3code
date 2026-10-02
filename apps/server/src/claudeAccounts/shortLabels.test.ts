import { describe, expect, it } from "@effect/vitest";

import { computeShortLabels } from "./shortLabels.ts";

describe("computeShortLabels", () => {
  it("uses the shortest unique prefix of each account name", () => {
    expect(computeShortLabels(["agent", "audit", "barsha", "sam", "tushar", "default"])).toEqual({
      agent: "ag",
      audit: "au",
      barsha: "b",
      sam: "s",
      tushar: "t",
      default: "d",
    });
  });

  it("lets an override claim a prefix another name would otherwise block", () => {
    expect(computeShortLabels(["agent", "audit", "tushar"], { agent: "a" })).toEqual({
      agent: "a",
      audit: "au",
      tushar: "t",
    });
  });

  it("keeps a prefix an override already uses away from other names", () => {
    expect(computeShortLabels(["tushar", "sam"], { sam: "t" })).toEqual({
      sam: "t",
      tushar: "tu",
    });
  });

  it("compares case-insensitively and falls back to the whole name", () => {
    expect(computeShortLabels(["Agent", "agent2"])).toEqual({ Agent: "agent", agent2: "agent2" });
  });
});
