import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

import { JsonToolResult, toJsonValue } from "./jsonToolResult.expbkt3.ts";

// A session read that carried an `undefined` field failed CallToolResult's own
// schema, and the agent saw only "internal server error".
const handlerValue = () => ({
  sessionId: "thread-1",
  snoozedUntil: undefined,
  updatedAt: new Date(Date.UTC(2026, 9, 11)),
  nested: [{ cost: Number.NaN, kept: 1 }],
});

describe("JsonToolResult", () => {
  it("drops undefined fields and turns dates and non-finite numbers into JSON", () => {
    expect(toJsonValue(handlerValue())).toEqual({
      sessionId: "thread-1",
      updatedAt: "2026-10-11T00:00:00.000Z",
      nested: [{ cost: null, kept: 1 }],
    });
    expect(toJsonValue(undefined)).toBeNull();
    expect(toJsonValue(10n)).toBe("10");
  });

  it("encodes a handler value that MCP accepts as structuredContent", () => {
    expect(
      () =>
        new McpSchema.CallToolResult({
          content: [],
          structuredContent: handlerValue() as never,
        }),
    ).toThrow();
    const encoded = Schema.encodeUnknownSync(JsonToolResult)(handlerValue());
    const result = new McpSchema.CallToolResult({
      content: [],
      structuredContent: encoded as never,
    });
    expect(result.structuredContent).toEqual(toJsonValue(handlerValue()));
  });
});
