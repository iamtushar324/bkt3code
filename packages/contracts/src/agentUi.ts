/**
 * T3-CUSTOM(expbkt3): agent-rendered UI surfaces in the chat transcript.
 *
 * An agent calls the `t3_show_ui` MCP tool with a small HTML document (or a URL)
 * and the chat mounts it as a sandboxed box inline, the way MCP Apps hosts render
 * `ui://` resources. Each call is one immutable render: re-running the tool makes
 * a new box rather than mutating an existing one, so a timeline row always shows
 * exactly what the agent produced at that moment.
 *
 * The HTML never travels on an activity payload — only the short render handle
 * does. Clients fetch the body through `agentUi.getRender`, which keeps the
 * websocket cheap and sidesteps the activity payload string cap.
 */
import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** How the box gets its content: an inline document, or a framed URL. */
export const AgentUiRenderKind = Schema.Literals(["html", "url"]);
export type AgentUiRenderKind = typeof AgentUiRenderKind.Type;

export const AGENT_UI_MIN_HEIGHT = 120;
export const AGENT_UI_MAX_HEIGHT = 900;
export const AGENT_UI_DEFAULT_HEIGHT = 360;
/** Largest inline document accepted from a tool call. */
export const AGENT_UI_MAX_HTML_CHARS = 262_144;

export const AgentUiRenderRecord = Schema.Struct({
  renderId: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: Schema.String,
  kind: AgentUiRenderKind,
  html: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  height: Schema.Number,
  createdAt: Schema.String,
});
export type AgentUiRenderRecord = typeof AgentUiRenderRecord.Type;

export const AgentUiGetRenderInput = Schema.Struct({
  threadId: ThreadId,
  renderId: TrimmedNonEmptyString,
});
export type AgentUiGetRenderInput = typeof AgentUiGetRenderInput.Type;

export const AgentUiGetRenderResult = Schema.Struct({
  render: Schema.NullOr(AgentUiRenderRecord),
});
export type AgentUiGetRenderResult = typeof AgentUiGetRenderResult.Type;

export class AgentUiError extends Schema.TaggedError<AgentUiError>()("AgentUiError", {
  operation: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
}) {}

/**
 * The handle the tool result carries back through the provider stream.
 *
 * Deliberately tiny and single-line: activity projection summarizes MCP results
 * to one short line, so anything larger would not survive to the client.
 */
export const AGENT_UI_RESULT_MARKER = "t3UiRender";

export interface AgentUiRenderHandle {
  readonly renderId: string;
  readonly kind: AgentUiRenderKind;
  readonly height: number;
  readonly title: string;
}
