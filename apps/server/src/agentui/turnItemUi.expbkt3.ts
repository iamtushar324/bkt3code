// T3-CUSTOM(expbkt3): native V2 tool items retain the agent UI render handle.
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const handleSchema = Schema.Struct({
  t3UiRender: Schema.Literal(true),
  renderId: Schema.String,
  kind: Schema.optional(Schema.Literals(["html", "url"])),
  height: Schema.optional(Schema.Number),
});
const decodeHandle = Schema.decodeUnknownOption(handleSchema);
const recordSchema = Schema.Record(Schema.String, Schema.Unknown);
const decodeRecord = Schema.decodeUnknownOption(recordSchema);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export function agentUiHandleFromOutput(
  output: unknown,
  depth = 0,
):
  | { readonly renderId: string; readonly kind?: "html" | "url"; readonly height?: number }
  | undefined {
  if (depth > 5) return undefined;
  const direct = decodeHandle(output);
  if (Option.isSome(direct) && direct.value.renderId.length > 0) {
    const { renderId, kind, height } = direct.value;
    return {
      renderId,
      ...(kind === undefined ? {} : { kind }),
      ...(height === undefined ? {} : { height }),
    };
  }
  if (typeof output === "string") {
    const decoded = decodeJson(output);
    return Option.isSome(decoded) ? agentUiHandleFromOutput(decoded.value, depth + 1) : undefined;
  }
  if (Array.isArray(output)) {
    for (const part of output) {
      const handle = agentUiHandleFromOutput(part, depth + 1);
      if (handle !== undefined) return handle;
    }
    return undefined;
  }
  const record = decodeRecord(output);
  if (Option.isNone(record)) return undefined;
  for (const key of ["structuredContent", "content", "text", "result", "output"]) {
    const handle = agentUiHandleFromOutput(record.value[key], depth + 1);
    if (handle !== undefined) return handle;
  }
  return undefined;
}

export function withAgentUiTurnItemHandle(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool") return item;
  const t3Ui = agentUiHandleFromOutput(item.output);
  if (t3Ui === undefined) return item;
  const record = decodeRecord(item.output);
  return {
    ...item,
    output: { ...(Option.isSome(record) ? record.value : { result: item.output }), t3Ui },
  };
}
