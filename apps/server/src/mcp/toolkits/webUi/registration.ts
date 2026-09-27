/**
 * T3-CUSTOM(expbkt3): Four compact MCP tools expose the complete authenticated
 * web UI RPC surface as a discoverable virtual-tool catalog.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
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

const callToolResult = (value: Readonly<object>, isError = false) =>
  new McpSchema.CallToolResult({
    isError,
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  });

const invalidToolInput = (message: string) =>
  callToolResult(
    {
      ok: false,
      error: { kind: "invalid_tool_input", message },
    },
    true,
  );

const decodePayload = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  payload: unknown,
) => Schema.decodeUnknownEffect(schema)(payload).pipe(Effect.result);

const invocationFromFiber = (fiber: Fiber.Fiber<unknown, unknown>) =>
  Context.getUnsafe(fiber.context, McpInvocationContext.McpInvocationContext);

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

export const registerWebUiRpcTools = Effect.fn("McpWebUiBridge.registerTools")(function* (
  execute: WebUiRpcExecutor,
) {
  const server = yield* McpServer.McpServer;
  const annotations = Context.empty();

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "t3_ui_list_tools",
      title: "List authenticated web UI tools",
      description:
        "List the complete virtual tool surface generated from bkt3's authenticated web UI RPC contract. Call this first for deep/code-mode control.",
      inputSchema: listToolsInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }),
    annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        Effect.gen(function* () {
          const decoded = yield* decodePayload(ListToolsSchema, payload);
          if (Result.isFailure(decoded)) return invalidToolInput(decoded.failure.message);
          const invocation = invocationFromFiber(fiber);
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
          return callToolResult({
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
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "t3_ui_get_tool",
      title: "Inspect an authenticated web UI tool",
      description:
        "Return the exact input, success, and declared error JSON schemas for one virtual web UI tool.",
      inputSchema: getToolInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }),
    annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        Effect.gen(function* () {
          const decoded = yield* decodePayload(GetToolSchema, payload);
          if (Result.isFailure(decoded)) return invalidToolInput(decoded.failure.message);
          const detail = getWebUiVirtualToolDetail(decoded.success.tool);
          if (!detail) return invalidToolInput(`Unknown virtual tool: ${decoded.success.tool}`);
          const scopes = makeWebUiAuthenticatedSession(invocationFromFiber(fiber)).scopes;
          return callToolResult({
            ok: true,
            tool: {
              ...detail,
              authorized: isWebUiVirtualToolAuthorized(detail, scopes),
            },
          });
        }),
      ),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "t3_ui_call",
      title: "Call an authenticated web UI tool",
      description:
        "Execute one virtual tool through the exact authenticated web UI handler, validation, authorization, visibility, and receipt path.",
      inputSchema: callInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        Effect.gen(function* () {
          const decoded = yield* decodePayload(VirtualCallSchema, payload);
          if (Result.isFailure(decoded)) return invalidToolInput(decoded.failure.message);
          const call = toCallRequest(decoded.success);
          if (!call) return invalidToolInput(`Unknown virtual tool: ${decoded.success.tool}`);
          const outcomes = yield* execute(invocationFromFiber(fiber), [call], false);
          const outcome = outcomes[0];
          if (!outcome) return invalidToolInput("The web UI call produced no outcome.");
          return callToolResult(outcome, !outcome.ok);
        }),
      ),
  });

  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "t3_ui_batch",
      title: "Batch authenticated web UI tools",
      description:
        "Execute up to 25 virtual web UI tools sequentially in one shared handler scope. Suitable for code-mode agents.",
      inputSchema: batchInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) =>
        Effect.gen(function* () {
          const decoded = yield* decodePayload(BatchSchema, payload);
          if (Result.isFailure(decoded)) return invalidToolInput(decoded.failure.message);
          if (decoded.success.calls.length === 0 || decoded.success.calls.length > 25) {
            return invalidToolInput("calls must contain between 1 and 25 operations.");
          }
          const calls: Array<WebUiRpcCallRequest> = [];
          for (const input of decoded.success.calls) {
            const call = toCallRequest(input);
            if (!call) return invalidToolInput(`Unknown virtual tool: ${input.tool}`);
            calls.push(call);
          }
          const outcomes = yield* execute(
            invocationFromFiber(fiber),
            calls,
            decoded.success.stopOnError === true,
          );
          const failed = outcomes.filter((outcome) => !outcome.ok).length;
          return callToolResult(
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

  yield* Effect.logInfo("registered authenticated web UI MCP bridge", {
    mcpToolCount: WEB_UI_MCP_TOOL_NAMES.length,
    virtualToolCount: WEB_UI_VIRTUAL_TOOL_COUNT,
    streamToolCount: WEB_UI_STREAM_TOOL_COUNT,
  });
});

export const makeWebUiRpcRegistrationLayer = (execute: WebUiRpcExecutor) =>
  Layer.effectDiscard(registerWebUiRpcTools(execute));

export const WebUiRpcRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const services = yield* Effect.context<WebUiRpcBridgeServices>();
    yield* registerWebUiRpcTools((invocation, calls, stopOnError) =>
      invokeWebUiRpcCalls(invocation, calls, stopOnError).pipe(Effect.provide(services)),
    );
  }),
);
