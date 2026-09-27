/**
 * T3-CUSTOM(expbkt3): wire-survival coverage for agent-rendered UI surfaces.
 *
 * The projection summarizes an MCP result down to one short line, so the render
 * handle only reaches the chat because this file carves it out first. Both
 * provider nestings are pinned here — Codex puts the result under `item`, Claude
 * leaves it flat — because losing either one silently turns every agent view
 * back into an ordinary collapsed tool row.
 */
import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

const RESULT_JSON = JSON.stringify({
  t3UiRender: true,
  renderId: "aui_abc123",
  kind: "html",
  height: 420,
});

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

function projectedData(payload: Record<string, unknown>): Record<string, unknown> {
  const projected = projectActivityPayload(activity(payload));
  return (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
}

describe("agent UI render handle projection", () => {
  it("keeps the handle from a Codex-shaped result nested under item", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: {
        item: {
          type: "mcpToolCall",
          tool: "t3_show_ui",
          server: "t3-code",
          result: { content: [{ type: "text", text: RESULT_JSON }] },
        },
      },
    });

    expect(data.t3Ui).toEqual({ renderId: "aui_abc123", height: 420, kind: "html" });
  });

  it("keeps the handle from a flat Claude-shaped tool result", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: {
        toolName: "mcp__t3-code__t3_show_ui",
        input: { title: "Chart" },
        result: { type: "tool_result", content: RESULT_JSON },
      },
    });

    expect(data.t3Ui).toEqual({ renderId: "aui_abc123", height: 420, kind: "html" });
  });

  it("keeps the handle when a provider sends structuredContent instead of text", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: {
        toolName: "mcp__t3-code__t3_show_ui",
        result: {
          content: [],
          structuredContent: {
            t3UiRender: true,
            renderId: "aui_abc123",
            kind: "html",
            height: 420,
          },
        },
      },
    });

    expect(data.t3Ui).toEqual({ renderId: "aui_abc123", height: 420, kind: "html" });
  });

  it("keeps the handle when the result object is the handle itself", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: {
        result: { t3UiRender: true, renderId: "aui_abc123", kind: "url", height: 200 },
      },
    });

    expect(data.t3Ui).toEqual({ renderId: "aui_abc123", height: 200, kind: "url" });
  });

  it("leaves ordinary MCP results alone", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: {
        toolName: "mcp__t3-code__t3_list_sessions",
        result: { content: [{ type: "text", text: '{"sessions":[]}' }] },
      },
    });

    expect(data.t3Ui).toBeUndefined();
  });

  it("ignores a result that claims the marker without a usable render id", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: {
        result: { content: JSON.stringify({ t3UiRender: true, renderId: "" }) },
      },
    });

    expect(data.t3Ui).toBeUndefined();
  });

  it("still summarizes the result body it carved the handle out of", () => {
    const data = projectedData({
      itemType: "mcp_tool_call",
      data: { result: { content: RESULT_JSON } },
    });

    expect(data.t3Ui).toBeDefined();
    // The bulky result is still summarized, not passed through wholesale.
    expect(typeof (data.result as Record<string, unknown>).content).toBe("string");
  });
});
