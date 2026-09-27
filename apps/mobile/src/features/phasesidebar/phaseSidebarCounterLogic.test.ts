import type { PhaseSidebarRow } from "@t3tools/client-runtime/state/phase-sidebar";
import { describe, expect, it } from "vite-plus/test";

import { countPhaseSidebarUnreadRows } from "./phaseSidebarCounterLogic";

const row = (input: {
  readonly unread: boolean;
  readonly archivedAt?: string | null;
  readonly settledAt?: string | null;
}): PhaseSidebarRow =>
  ({
    isUnreadCompletion: input.unread,
    thread: {
      archivedAt: input.archivedAt ?? null,
      settledAt: input.settledAt ?? null,
    },
  }) as PhaseSidebarRow;

describe("countPhaseSidebarUnreadRows", () => {
  it("counts exactly the unsettled, unarchived rows that render unread", () => {
    expect(
      countPhaseSidebarUnreadRows([
        row({ unread: true }),
        row({ unread: true }),
        row({ unread: false }),
        row({ unread: true, settledAt: "2026-09-05T00:00:00.000Z" }),
        row({ unread: true, archivedAt: "2026-09-05T00:00:00.000Z" }),
      ]),
    ).toBe(2);
  });
});
