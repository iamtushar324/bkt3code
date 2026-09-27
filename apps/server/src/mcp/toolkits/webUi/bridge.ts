/**
 * T3-CUSTOM(expbkt3): Executes compact MCP calls through the exact authenticated
 * web RPC handler layer, including its scope and project/thread visibility.
 */
import { WsRpcGroup } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { Headers } from "effect/unstable/http";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcMessage from "effect/unstable/rpc/RpcMessage";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import * as ServerSelfUpdate from "../../../cloud/selfUpdate.ts";
import { makeAuthenticatedWsRpcHandlerLayer } from "../../../ws.ts";
import type * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { type WebUiRpcMethod, type WebUiRpcStreamMode, webUiRpcDefinition } from "./catalog.ts";
import { makeWebUiAuthenticatedSession } from "./session.ts";

export interface WebUiStreamOptions {
  readonly maxItems?: number;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

export interface NormalizedWebUiStreamOptions {
  readonly maxItems: number;
  readonly idleTimeoutMs: number;
  readonly totalTimeoutMs: number;
}

export interface WebUiRpcCallRequest {
  readonly id?: string;
  readonly tool: string;
  readonly method: WebUiRpcMethod;
  readonly input?: unknown;
  readonly stream?: WebUiStreamOptions;
}

export type WebUiRpcCallOutcome =
  | {
      readonly ok: true;
      readonly id?: string;
      readonly index: number;
      readonly tool: string;
      readonly method: WebUiRpcMethod;
      readonly stream: false;
      readonly result: unknown;
    }
  | {
      readonly ok: true;
      readonly id?: string;
      readonly index: number;
      readonly tool: string;
      readonly method: WebUiRpcMethod;
      readonly stream: true;
      readonly events: ReadonlyArray<unknown>;
      readonly collection: NormalizedWebUiStreamOptions & {
        readonly count: number;
        readonly ended: "max_items" | "complete_or_timeout";
      };
    }
  | {
      readonly ok: false;
      readonly id?: string;
      readonly index: number;
      readonly tool: string;
      readonly method: WebUiRpcMethod;
      readonly error: {
        readonly kind: "invalid_input" | "invalid_stream_options" | "rpc_error" | "internal_error";
        readonly message: string;
        readonly value?: unknown;
      };
    };

const SUBSCRIPTION_DEFAULTS: NormalizedWebUiStreamOptions = {
  maxItems: 50,
  idleTimeoutMs: 1_500,
  totalTimeoutMs: 5_000,
};

const PROGRESS_DEFAULTS: NormalizedWebUiStreamOptions = {
  maxItems: 200,
  idleTimeoutMs: 30_000,
  totalTimeoutMs: 300_000,
};

const clampInteger = (value: number | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

export const normalizeWebUiStreamOptions = (
  mode: WebUiRpcStreamMode,
  options: WebUiStreamOptions | undefined,
): NormalizedWebUiStreamOptions => {
  const defaults = mode === "progress" ? PROGRESS_DEFAULTS : SUBSCRIPTION_DEFAULTS;
  const idleTimeoutMs = clampInteger(options?.idleTimeoutMs, defaults.idleTimeoutMs, 100, 60_000);
  const totalTimeoutMs = Math.max(
    idleTimeoutMs,
    clampInteger(options?.totalTimeoutMs, defaults.totalTimeoutMs, 1_000, 300_000),
  );
  return {
    maxItems: clampInteger(options?.maxItems, defaults.maxItems, 1, 500),
    idleTimeoutMs,
    totalTimeoutMs,
  };
};

type WebUiHandlerLayer = ReturnType<typeof makeAuthenticatedWsRpcHandlerLayer>;
type WebUiHandlerServices = Layer.Success<WebUiHandlerLayer>;
export type WebUiRpcBridgeServices =
  | Layer.Services<WebUiHandlerLayer>
  | PreviewAutomationBroker.PreviewAutomationBroker
  | ServerSelfUpdate.ServerSelfUpdate;
type RuntimeSchema = Schema.Codec<unknown, unknown, never, never>;

type DynamicWebUiHandler = (
  payload: unknown,
  options: {
    readonly client: Rpc.ServerClient;
    readonly requestId: RpcMessage.RequestId;
    readonly headers: Headers.Headers;
  },
) => Effect.Effect<unknown, Types.unhandled> | Stream.Stream<unknown, Types.unhandled>;

const runtimeSchema = (schema: Schema.Top): RuntimeSchema => schema as RuntimeSchema;

const outcomeBase = (request: WebUiRpcCallRequest, index: number) => ({
  ...(request.id === undefined ? {} : { id: request.id }),
  index,
  tool: request.tool,
  method: request.method,
});

const invalidOutcome = (
  request: WebUiRpcCallRequest,
  index: number,
  kind: "invalid_input" | "invalid_stream_options",
  message: string,
): WebUiRpcCallOutcome => ({
  ok: false,
  ...outcomeBase(request, index),
  error: { kind, message },
});

const internalOutcome = (request: WebUiRpcCallRequest, index: number): WebUiRpcCallOutcome => ({
  ok: false,
  ...outcomeBase(request, index),
  error: {
    kind: "internal_error",
    message: "The authenticated web UI operation failed inside the server.",
  },
});

const encodeUnknown = (schema: Schema.Top, value: unknown) =>
  Schema.encodeUnknownEffect(runtimeSchema(schema))(value).pipe(
    Effect.match({
      onFailure: () => Option.none<unknown>(),
      onSuccess: Option.some,
    }),
  );

const invokeWithHandlerContext = Effect.fn("McpWebUiBridge.invokeWithHandlerContext")(function* (
  handlerContext: Context.Context<WebUiHandlerServices>,
  request: WebUiRpcCallRequest,
  index: number,
) {
  const rpc = webUiRpcDefinition(request.method);
  const isStream = RpcSchema.isStreamSchema(rpc.successSchema);
  if (!isStream && request.stream !== undefined) {
    return invalidOutcome(
      request,
      index,
      "invalid_stream_options",
      `${request.tool} is not a streaming operation.`,
    );
  }

  const decoded = yield* Schema.decodeUnknownEffect(runtimeSchema(rpc.payloadSchema))(
    request.input ?? {},
  ).pipe(Effect.result);
  if (Result.isFailure(decoded)) {
    return invalidOutcome(request, index, "invalid_input", decoded.failure.message);
  }

  const dynamicHandlerContext = handlerContext as Context.Context<Rpc.Handler<WebUiRpcMethod>>;
  const handler = yield* WsRpcGroup.accessHandler(request.method).pipe(
    Effect.provide(dynamicHandlerContext),
  );
  const dynamicHandler = handler as unknown as DynamicWebUiHandler;
  const response = dynamicHandler(decoded.success, {
    client: new Rpc.ServerClient(index),
    requestId: RpcMessage.RequestId(`mcp-web-ui:${index}`),
    headers: Headers.empty,
  });

  const successSchema = isStream ? rpc.successSchema.success : rpc.successSchema;
  const errorSchema = isStream ? rpc.successSchema.error : rpc.errorSchema;
  const streamMode: WebUiRpcStreamMode =
    request.method === "server.updateServerWithProgress" ||
    request.method === "cloud.installRelayClient" ||
    request.method === "git.runStackedAction"
      ? "progress"
      : "subscription";
  const streamOptions = normalizeWebUiStreamOptions(streamMode, request.stream);
  let execution: Effect.Effect<unknown, Types.unhandled>;
  if (isStream) {
    if (!Stream.isStream(response)) return internalOutcome(request, index);
    execution = response.pipe(
      Stream.take(streamOptions.maxItems),
      Stream.timeout(streamOptions.idleTimeoutMs),
      Stream.interruptWhen(Effect.sleep(streamOptions.totalTimeoutMs)),
      Stream.runCollect,
    );
  } else {
    if (!Effect.isEffect(response)) return internalOutcome(request, index);
    execution = response;
  }

  return yield* execution.pipe(
    Effect.flatMap((value) => {
      if (isStream) {
        const events = value as ReadonlyArray<unknown>;
        return Effect.forEach(events, (event) => encodeUnknown(successSchema, event)).pipe(
          Effect.flatMap((encoded) => {
            if (encoded.some(Option.isNone)) return Effect.succeed(internalOutcome(request, index));
            const values = encoded.map(Option.getOrThrow);
            return Effect.succeed<WebUiRpcCallOutcome>({
              ok: true,
              ...outcomeBase(request, index),
              stream: true,
              events: values,
              collection: {
                ...streamOptions,
                count: values.length,
                ended:
                  values.length >= streamOptions.maxItems ? "max_items" : "complete_or_timeout",
              },
            });
          }),
        );
      }
      return encodeUnknown(successSchema, value).pipe(
        Effect.map((encoded): WebUiRpcCallOutcome =>
          Option.isNone(encoded)
            ? internalOutcome(request, index)
            : {
                ok: true,
                ...outcomeBase(request, index),
                stream: false,
                result: encoded.value ?? null,
              },
        ),
      );
    }),
    Effect.catch((error) =>
      encodeUnknown(errorSchema, error).pipe(
        Effect.map((encoded): WebUiRpcCallOutcome =>
          Option.isNone(encoded)
            ? internalOutcome(request, index)
            : {
                ok: false,
                ...outcomeBase(request, index),
                error: {
                  kind: "rpc_error",
                  message: `The ${request.method} web UI operation was rejected.`,
                  value: encoded.value ?? null,
                },
              },
        ),
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError("authenticated web UI MCP operation defect", {
        method: request.method,
        defect,
      }).pipe(Effect.as(internalOutcome(request, index))),
    ),
  );
});

export const invokeWebUiRpcCalls = Effect.fn("McpWebUiBridge.invokeCalls")(function* (
  invocation: McpInvocationContext.McpInvocationScope,
  calls: ReadonlyArray<WebUiRpcCallRequest>,
  stopOnError = false,
) {
  const operation = Effect.scoped(
    Effect.gen(function* () {
      const session = makeWebUiAuthenticatedSession(invocation);
      const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const handlerLayer = makeAuthenticatedWsRpcHandlerLayer(
        session,
        // T3-CUSTOM(expbkt3): the MCP web-UI bridge is not a client surface, so it
        // reports an empty client origin to upstream's analytics plumbing.
        {},
        previewAutomationBroker,
        serverSelfUpdate,
      );
      const handlerContext = yield* Layer.build(handlerLayer);
      const outcomes: Array<WebUiRpcCallOutcome> = [];
      for (const [index, call] of calls.entries()) {
        const outcome = yield* invokeWithHandlerContext(handlerContext, call, index);
        outcomes.push(outcome);
        if (stopOnError && !outcome.ok) break;
      }
      return outcomes;
    }),
  );
  return yield* operation.pipe(
    Effect.catch((error) =>
      Effect.logError("failed to build authenticated web UI MCP handler layer", { error }).pipe(
        Effect.as(calls.map((call, index) => internalOutcome(call, index))),
      ),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError("authenticated web UI MCP bridge defect", { defect }).pipe(
        Effect.as(calls.map((call, index) => internalOutcome(call, index))),
      ),
    ),
  );
});
