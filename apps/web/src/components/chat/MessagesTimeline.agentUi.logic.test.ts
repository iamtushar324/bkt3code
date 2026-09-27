/**
 * T3-CUSTOM(expbkt3): agent views must survive work-log grouping.
 *
 * Tool rows collapse into a "+N tool calls" toggle once several land in a row,
 * which is right for a record that work happened and wrong for an agent view:
 * the view *is* the answer, so collapsing it hides the thing the user asked
 * for. These tests pin that a `t3_show_ui` row is always rendered on its own,
 * without the reader expanding anything.
 */
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows, workEntryStaysVisible } from "./MessagesTimeline.logic";

function toolEntry(id: string, at: string) {
  return {
    id: `entry-${id}`,
    kind: "work" as const,
    createdAt: at,
    entry: {
      id,
      createdAt: at,
      turnId: "turn-1" as never,
      label: "Ran a tool",
      tone: "tool" as const,
      itemType: "mcp_tool_call" as const,
      toolLifecycleStatus: "completed" as const,
    },
  };
}

function agentUiEntry(id: string, at: string) {
  const base = toolEntry(id, at);
  return {
    ...base,
    entry: { ...base.entry, label: "Showed a view", agentUi: { renderId: `aui_${id}` } },
  };
}

const derive = (timelineEntries: ReadonlyArray<ReturnType<typeof toolEntry>>) =>
  deriveMessagesTimelineRows({
    timelineEntries,
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
  });

/** Every work entry the reader can see without expanding a toggle. */
function visibleWorkEntryIds(rows: ReturnType<typeof derive>): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind === "work") {
      for (const entry of row.groupedEntries) ids.push(entry.id);
    }
  }
  return ids;
}

describe("workEntryStaysVisible", () => {
  it("covers agent views as well as spawn rows", () => {
    expect(workEntryStaysVisible({ agentUi: { renderId: "aui_1" } } as never)).toBe(true);
    expect(
      workEntryStaysVisible({ agentSpawn: { workflowId: null, agentTaskIds: [] } } as never),
    ).toBe(true);
  });

  it("leaves an ordinary tool row collapsible", () => {
    expect(workEntryStaysVisible({ label: "Ran a tool" } as never)).toBe(false);
    expect(workEntryStaysVisible({ agentUi: undefined } as never)).toBe(false);
  });
});

describe("agent views in the work log", () => {
  it("renders the view without the reader expanding anything", () => {
    const rows = derive([
      toolEntry("tool-1", "2026-01-01T00:00:01Z"),
      toolEntry("tool-2", "2026-01-01T00:00:02Z"),
      agentUiEntry("view-1", "2026-01-01T00:00:03Z"),
      toolEntry("tool-3", "2026-01-01T00:00:04Z"),
    ]);

    expect(visibleWorkEntryIds(rows)).toContain("view-1");
  });

  it("still folds the same run away when none of them is a view", () => {
    // The control. Without a view the whole settled turn folds and no work row
    // survives — which is exactly what was swallowing the box before, and what
    // must keep happening for ordinary tool calls.
    const rows = derive([
      toolEntry("tool-1", "2026-01-01T00:00:01Z"),
      toolEntry("tool-2", "2026-01-01T00:00:02Z"),
      toolEntry("tool-3", "2026-01-01T00:00:03Z"),
      toolEntry("tool-4", "2026-01-01T00:00:04Z"),
    ]);

    expect(visibleWorkEntryIds(rows)).toEqual([]);
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(true);
  });

  it("keeps every view visible when several land in one run", () => {
    const rows = derive([
      toolEntry("tool-1", "2026-01-01T00:00:01Z"),
      agentUiEntry("view-1", "2026-01-01T00:00:02Z"),
      toolEntry("tool-2", "2026-01-01T00:00:03Z"),
      agentUiEntry("view-2", "2026-01-01T00:00:04Z"),
      toolEntry("tool-3", "2026-01-01T00:00:05Z"),
    ]);

    const visible = visibleWorkEntryIds(rows);
    expect(visible).toContain("view-1");
    expect(visible).toContain("view-2");
  });

  it("renders a lone view on its own", () => {
    const rows = derive([agentUiEntry("view-1", "2026-01-01T00:00:01Z")]);
    expect(visibleWorkEntryIds(rows)).toEqual(["view-1"]);
  });
});
