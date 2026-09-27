import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { T3ControlToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

it("exports self-documenting, provider-compatible T3 control tools", () => {
  const tools = Object.values(T3ControlToolkit.tools);
  expect(tools.length).toBeGreaterThanOrEqual(15);
  expect(T3ControlToolkit.tools.t3_create_project).toBeDefined();
  // T3-CUSTOM(expbkt3): project creation defaults are writable through MCP.
  expect(T3ControlToolkit.tools.t3_update_project).toBeDefined();

  for (const tool of tools) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass: ${JSON.stringify(fieldSchema)}`,
      ).toBe(true);
    }
  }
});
