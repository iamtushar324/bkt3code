/**
 * T3-CUSTOM(expbkt3): Four compact MCP tools expose the complete authenticated
 * web UI RPC surface as a discoverable virtual-tool catalog.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import type * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  invokeWebUiRpcCalls,
  type WebUiRpcBridgeServices,
  type WebUiRpcCallOutcome,
  type WebUiRpcCallRequest,
  type WebUiStreamOptions,
} from "./bridge.ts";
import {
  getWebUiVirtualTool,
  getWebUiVirtualToolDetail,
  isWebUiVirtualToolAuthorized,
  WEB_UI_STREAM_TOOL_COUNT,
  WEB_UI_VIRTUAL_TOOL_COUNT,
  WEB_UI_VIRTUAL_TOOLS,
} from "./catalog.ts";
import { makeWebUiAuthenticatedSession } from "./session.ts";

export const WEB_UI_MCP_TOOL_NAMES = [
  "t3_ui_list_tools",
  "t3_ui_get_tool",
  "t3_ui_call",
  "t3_ui_batch",
] as const;

const virtualToolNames = WEB_UI_VIRTUAL_TOOLS.map((tool) => tool.name);

const streamOptionsJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxItems: {
      type: "number",
      minimum: 1,
      maximum: 500,
      description: "Maximum events to collect before closing the stream window.",
    },
    idleTimeoutMs: {
      type: "number",
      minimum: 100,
      maximum: 60_000,
      description: "Close the window when no event arrives within this interval.",
    },
    totalTimeoutMs: {
      type: "number",
      minimum: 1_000,
      maximum: 300_000,
      description: "Absolute upper bound for the stream window.",
    },
  },
} as const;

const virtualCallProperties = {
  id: { type: "string", description: "Optional caller correlation ID." },
  tool: {
    type: "string",
    enum: virtualToolNames,
    description: "Virtual tool name from t3_ui_list_tools.",
  },
  input: {
    description: "Input validated against the virtual tool's exact web RPC schema.",
  },
  stream: streamOptionsJsonSchema,
} as const;

const listToolsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Case-insensitive name, method, or category filter." },
    authorizedOnly: {
      type: "boolean",
      description: "Return only tools whose transport scope is present for this caller.",
    },
    cursor: { type: "number", minimum: 0, description: "Zero-based result offset." },
    limit: { type: "number", minimum: 1, maximum: 100, description: "Page size." },
  },
} as const;

const getToolInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tool"],
  properties: {
    tool: { type: "string", enum: virtualToolNames },
  },
} as const;

const callInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tool"],
  properties: virtualCallProperties,
} as const;

const batchInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["calls"],
  properties: {
    calls: {
      type: "array",
      minItems: 1,
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["tool"],
        properties: virtualCallProperties,
      },
    },
    stopOnError: {
      type: "boolean",
      description: "Stop before later calls after the first rejected or failed operation.",
    },
  },
} as const;

const StreamOptionsSchema = Schema.Struct({
  maxItems: Schema.optionalKey(Schema.Number),
  idleTimeoutMs: Schema.optionalKey(Schema.Number),
  totalTimeoutMs: Schema.optionalKey(Schema.Number),
});

const VirtualCallSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  tool: Schema.String,
  input: Schema.optionalKey(Schema.Unknown),
  stream: Schema.optionalKey(StreamOptionsSchema),
});

const ListToolsSchema = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  authorizedOnly: Schema.optionalKey(Schema.Boolean),
  cursor: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});

const GetToolSchema = Schema.Struct({ tool: Schema.String });
const BatchSchema = Schema.Struct({
  calls: Schema.Array(VirtualCallSchema),
  stopOnError: Schema.optionalKey(Schema.Boolean),
});

type WebUiRpcExecutor = (
  invocation: McpInvocationContext.McpInvocationScope,
  calls: ReadonlyArray<WebUiRpcCallRequest>,
  stopOnError: boolean,
) => Effect.Effect<ReadonlyArray<WebUiRpcCallOutcome>>;

const decodePayload = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  payload: unknown,
) => Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.result);

const normalizedOffset = (value: number | undefined, fallback: number, maximum: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
};

const toCallRequest = (input: typeof VirtualCallSchema.Type): WebUiRpcCallRequest | undefined => {
  const tool = getWebUiVirtualTool(input.tool);
  if (!tool) return undefined;
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    tool: tool.name,
    method: tool.method,
    ...(input.input === undefined ? {} : { input: input.input }),
    ...(input.stream === undefined ? {} : { stream: input.stream as WebUiStreamOptions }),
  };
};

/**
 * A failed tool result: an `OrchestratorMcpFailure` from the access check, or
 * the bridge's own `{ ok: false, ... }` body, which goes back as an error
 * result with that body as its text.
 */
const WebUiToolFailure = Schema.Union([OrchestratorMcpFailure, Schema.Unknown]);

/** What every handler needs; `dependencies` is type-only, so a dynamic tool states it here. */
type WebUiToolServices =
  | McpInvocationContext.McpInvocationContext
  | ThreadManagementService.ThreadManagementService;

/**
 * A tool that advertises its hand-written JSON schema (the virtual-tool enum
 * and bounds) and decodes its own payload, so a bad virtual call comes back as
 * a tool result the agent can read.
 */
const webUiTool = <const Name extends string>(
  name: Name,
  options: {
    readonly title: string;
    readonly description: string;
    readonly inputSchema: object;
    readonly readOnly: boolean;
  },
) =>
  Tool.dynamic(name, {
    description: options.description,
    // The hand-written schemas are JSON Schema objects; `as const` makes their arrays readonly.
    parameters: options.inputSchema as JsonSchema.JsonSchema,
    success: Schema.Unknown,
    failure: WebUiToolFailure,
  })
    .annotate(Tool.Title, options.title)
    .annotate(Tool.Readonly, options.readOnly)
    .annotate(Tool.Destructive, !options.readOnly)
    .annotate(Tool.Idempotent, options.readOnly)
    .annotate(Tool.OpenWorld, !options.readOnly) as unknown as Tool.Tool<
    Name,
    {
      readonly parameters: typeof Schema.Unknown;
      readonly success: typeof Schema.Unknown;
      readonly failure: typeof WebUiToolFailure;
      readonly failureMode: "error";
    },
    WebUiToolServices
  >;

export const WebUiRpcToolkit = Toolkit.make(
  webUiTool("t3_ui_list_tools", {
    title: "List authenticated web UI tools",
    description:
      "List the complete virtual tool surface generated from bkt3's authenticated web UI RPC contract. Call this first for deep/code-mode control.",
    inputSchema: listToolsInputSchema,
    readOnly: true,
  }),
  webUiTool("t3_ui_get_tool", {
    title: "Inspect an authenticated web UI tool",
    description:
      "Return the exact input, success, and declared error JSON schemas for one virtual web UI tool.",
    inputSchema: getToolInputSchema,
    readOnly: true,
  }),
  webUiTool("t3_ui_call", {
    title: "Call an authenticated web UI tool",
    description:
      "Execute one virtual tool through the exact authenticated web UI handler, validation, authorization, visibility, and receipt path.",
    inputSchema: callInputSchema,
    readOnly: false,
  }),
  webUiTool("t3_ui_batch", {
    title: "Batch authenticated web UI tools",
    description:
      "Execute up to 25 virtual web UI tools sequentially in one shared handler scope. Suitable for code-mode agents.",
    inputSchema: batchInputSchema,
    readOnly: false,
  }),
);

/** A successful result's body, or the failure that carries a failed one. */
const toolResult = (
  value: Readonly<object>,
  isError = false,
): Effect.Effect<Readonly<object>, Readonly<object>> =>
  isError ? Effect.fail(value) : Effect.succeed(value);

const invalidToolInput = (message: string) =>
  toolResult({ ok: false, error: { kind: "invalid_tool_input", message } }, true);

/**
 * Who may call each bridge tool (see McpToolAccess). Listing and inspecting
 * read; a virtual call can reach any web UI RPC, settings and projects
 * included, so it needs a full-access caller.
 */
const webUiRpcHandlers = (execute: WebUiRpcExecutor) => ({
    t3_ui_list_tools: McpToolAccess.reads((payload: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodePayload(ListToolsSchema, payload);
        if (Result.isFailure(decoded)) return yield* invalidToolInput(decoded.failure.message);
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const scopes = makeWebUiAuthenticatedSession(invocation).scopes;
        const query = decoded.success.query?.trim().toLowerCase() ?? "";
        const filtered = WEB_UI_VIRTUAL_TOOLS.filter((tool) => {
          const authorized = isWebUiVirtualToolAuthorized(tool, scopes);
          if (decoded.success.authorizedOnly === true && !authorized) return false;
          return (
            query.length === 0 ||
            tool.name.includes(query) ||
            tool.method.toLowerCase().includes(query) ||
            tool.category.toLowerCase().includes(query)
          );
        });
        const cursor = normalizedOffset(decoded.success.cursor, 0, filtered.length);
        const limit = normalizedOffset(decoded.success.limit, 100, 100) || 1;
        const page = filtered.slice(cursor, cursor + limit).map((tool) => ({
          ...tool,
          authorized: isWebUiVirtualToolAuthorized(tool, scopes),
        }));
        const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
        return yield* toolResult({
          ok: true,
          rpcCount: WEB_UI_VIRTUAL_TOOL_COUNT,
          streamCount: WEB_UI_STREAM_TOOL_COUNT,
          matchedCount: filtered.length,
          cursor,
          nextCursor,
          tools: page,
          note: "authorized reflects the transport scope only; each call still enforces the web UI's user, project, thread, and administrator checks.",
        });
      }),
    ),
    t3_ui_get_tool: McpToolAccess.reads((payload: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodePayload(GetToolSchema, payload);
        if (Result.isFailure(decoded)) return yield* invalidToolInput(decoded.failure.message);
        const detail = getWebUiVirtualToolDetail(decoded.success.tool);
        if (!detail) {
          return yield* invalidToolInput(`Unknown virtual tool: ${decoded.success.tool}`);
        }
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const scopes = makeWebUiAuthenticatedSession(invocation).scopes;
        return yield* toolResult({
          ok: true,
          tool: {
            ...detail,
            authorized: isWebUiVirtualToolAuthorized(detail, scopes),
          },
        });
      }),
    ),
    t3_ui_call: McpToolAccess.writesEnvironment((payload: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodePayload(VirtualCallSchema, payload);
        if (Result.isFailure(decoded)) return yield* invalidToolInput(decoded.failure.message);
        const call = toCallRequest(decoded.success);
        if (!call) {
          return yield* invalidToolInput(`Unknown virtual tool: ${decoded.success.tool}`);
        }
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const outcomes = yield* execute(invocation, [call], false);
        const outcome = outcomes[0];
        if (!outcome) return yield* invalidToolInput("The web UI call produced no outcome.");
        return yield* toolResult(outcome, !outcome.ok);
      }),
    ),
    t3_ui_batch: McpToolAccess.writesEnvironment((payload: unknown) =>
      Effect.gen(function* () {
        const decoded = yield* decodePayload(BatchSchema, payload);
        if (Result.isFailure(decoded)) return yield* invalidToolInput(decoded.failure.message);
        if (decoded.success.calls.length === 0 || decoded.success.calls.length > 25) {
          return yield* invalidToolInput("calls must contain between 1 and 25 operations.");
        }
        const calls: Array<WebUiRpcCallRequest> = [];
        for (const input of decoded.success.calls) {
          const call = toCallRequest(input);
          if (!call) return yield* invalidToolInput(`Unknown virtual tool: ${input.tool}`);
          calls.push(call);
        }
        const invocation = yield* McpInvocationContext.McpInvocationContext;
        const outcomes = yield* execute(invocation, calls, decoded.success.stopOnError === true);
        const failed = outcomes.filter((outcome) => !outcome.ok).length;
        return yield* toolResult(
          {
            ok: failed === 0,
            requestedCount: calls.length,
            completedCount: outcomes.length,
            failedCount: failed,
            results: outcomes,
          },
          failed > 0,
        );
      }),
    ),
  });

/** The bridge with an injected executor, for focused registration tests. */
export const makeWebUiRpcHandlers = (execute: WebUiRpcExecutor) =>
  McpToolAccess.toLayer(WebUiRpcToolkit, webUiRpcHandlers(execute));

/** The production bridge: virtual calls run through the authenticated web UI handlers. */
export const WebUiRpcHandlers = McpToolAccess.toLayer(
  WebUiRpcToolkit,
  Effect.map(Effect.context<WebUiRpcBridgeServices>(), (services) =>
    webUiRpcHandlers((invocation, calls, stopOnError) =>
      invokeWebUiRpcCalls(invocation, calls, stopOnError).pipe(Effect.provide(services)),
    ),
  ),
);
