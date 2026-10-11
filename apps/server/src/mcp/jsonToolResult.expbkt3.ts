/**
 * T3-CUSTOM(expbkt3): tool results that MCP can send.
 *
 * A tool's `structuredContent` must be plain JSON. Effect's MCP server builds
 * the CallToolResult from the encoded success value, and that result's schema
 * rejects an `undefined` field, a Date, a class instance or a non-finite
 * number; the client then sees only "Tool execution failed due to an internal
 * server error". Tools whose success schema is `Schema.Unknown` pass their
 * handler's value through unchanged, so they declare `JsonToolResult`, which
 * encodes through a JSON round trip: the value the text content already shows.
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** `value` as JSON would carry it: undefined fields dropped, dates as ISO strings. */
export const toJsonValue = (value: unknown): unknown => {
  const text = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  return text === undefined ? null : (JSON.parse(text) as unknown);
};

/** An untyped tool result, encoded as plain JSON. */
export const JsonToolResult = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    SchemaTransformation.transform({
      decode: (value: unknown) => value,
      encode: toJsonValue,
    }),
  ),
);
