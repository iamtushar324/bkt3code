// T3-CUSTOM(expbkt3): real provider result envelopes retain the UI handle.
import { describe, expect, it } from "vite-plus/test";
import { agentUiHandleFromOutput } from "./turnItemUi.expbkt3.ts";
const handle = { t3UiRender: true, renderId: "render-test", kind: "html", height: 240 };
describe("native agent UI result envelopes", () => {
  it("extracts Codex MCP content without leaking the HTML body", () => {
    expect(
      agentUiHandleFromOutput({
        content: [{ type: "text", text: JSON.stringify({ ...handle, html: "private-body" }) }],
      }),
    ).toEqual({ renderId: "render-test", kind: "html", height: 240 });
  });
  it("extracts Claude structured content", () => {
    expect(agentUiHandleFromOutput({ structuredContent: handle })).toEqual({
      renderId: "render-test",
      kind: "html",
      height: 240,
    });
  });
  it("ignores a normal tool result and a malformed handle", () => {
    expect(agentUiHandleFromOutput({ content: [{ type: "text", text: "done" }] })).toBeUndefined();
    expect(agentUiHandleFromOutput({ t3UiRender: true, renderId: "" })).toBeUndefined();
  });
});
