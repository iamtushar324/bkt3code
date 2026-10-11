import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import {
  resolveT3McpToolPresentation,
  resolveT3McpToolSummaryAction,
} from "@t3tools/shared/t3McpToolPresentation";

import { T3ControlToolkit } from "../control/tools.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import { AgentToolkit } from "./tools.ts";

it("publishes object-root, reference-free tools with labels and unclassified names", () => {
  const taken = new Set(
    [T3ControlToolkit, OrchestratorToolkit, ThreadToolkit].flatMap((toolkit) =>
      Object.values(toolkit.tools).map((tool) => tool.name),
    ),
  );
  for (const tool of Object.values(AgentToolkit.tools)) {
    expect(taken.has(tool.name), tool.name).toBe(false);
    const schema = Tool.getJsonSchema(tool);
    expect(schema, tool.name).toMatchObject({ type: "object" });
    expect(JSON.stringify(schema), tool.name).not.toContain('"$ref"');
    // Provider adapters classify tool rows by these words (see t3_show_ui).
    expect(tool.name, tool.name).not.toMatch(/create|file|agent|command/);
    expect(resolveT3McpToolPresentation(`mcp__t3-code__${tool.name}`)?.logo, tool.name).toBe(
      "t3-code",
    );
    expect(resolveT3McpToolSummaryAction(tool.name), tool.name).not.toBeNull();
  }
});
