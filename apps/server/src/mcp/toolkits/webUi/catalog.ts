/**
 * T3-CUSTOM(expbkt3): Compact, generated catalog for every authenticated web
 * RPC. The four real MCP tools expose these virtual tools without injecting a
 * hundred large schemas into every provider prompt.
 */
import { type AuthEnvironmentScope, WsRpcGroup } from "@t3tools/contracts";
import { Tool } from "effect/unstable/ai";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";

import { requiredScopeForRpcMethod } from "../../../auth/RpcAuthorization.ts";

export type WebUiRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];
export type WebUiRpcStreamMode = "subscription" | "progress";

export interface WebUiVirtualTool {
  readonly name: string;
  readonly method: WebUiRpcMethod;
  readonly category: string;
  readonly description: string;
  readonly requiredScope: AuthEnvironmentScope;
  readonly readOnly: boolean;
  readonly stream: boolean;
  readonly streamMode: WebUiRpcStreamMode | null;
}

export interface WebUiVirtualToolDetail extends WebUiVirtualTool {
  readonly inputSchema: unknown;
  readonly successSchema: unknown;
  readonly errorSchema: unknown;
}

const READ_SCOPES = new Set<AuthEnvironmentScope>([
  "orchestration:read",
  "access:read",
  "relay:read",
]);

const PROGRESS_STREAM_METHODS = new Set<WebUiRpcMethod>([
  "server.updateServerWithProgress",
  "cloud.installRelayClient",
  "git.runStackedAction",
]);

export const webUiVirtualToolName = (method: string): string =>
  `t3_ui_${method}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase();

const rpcWithProps = (method: WebUiRpcMethod): Rpc.AnyWithProps => {
  const rpc = WsRpcGroup.requests.get(method);
  if (!rpc) throw new Error(`Unknown authenticated web RPC: ${method}`);
  return rpc;
};

const streamModeFor = (method: WebUiRpcMethod): WebUiRpcStreamMode | null => {
  const rpc = rpcWithProps(method);
  if (!RpcSchema.isStreamSchema(rpc.successSchema)) return null;
  return PROGRESS_STREAM_METHODS.has(method) ? "progress" : "subscription";
};

const categoryFor = (method: string): string => {
  const separator = method.indexOf(".");
  if (separator >= 0) return method.slice(0, separator);
  if (method.startsWith("subscribe")) return "subscriptions";
  return "server";
};

export const WEB_UI_VIRTUAL_TOOLS: ReadonlyArray<WebUiVirtualTool> = Array.from(
  WsRpcGroup.requests.keys(),
  (method): WebUiVirtualTool => {
    const rpcMethod = method as WebUiRpcMethod;
    const streamMode = streamModeFor(rpcMethod);
    const requiredScope = requiredScopeForRpcMethod(rpcMethod);
    return {
      name: webUiVirtualToolName(rpcMethod),
      method: rpcMethod,
      category: categoryFor(rpcMethod),
      description: `Authenticated web UI ${streamMode === null ? "operation" : `${streamMode} stream`} for ${rpcMethod}.`,
      requiredScope,
      readOnly: READ_SCOPES.has(requiredScope),
      stream: streamMode !== null,
      streamMode,
    };
  },
).toSorted((left, right) => left.name.localeCompare(right.name));

export const WEB_UI_VIRTUAL_TOOL_COUNT = WEB_UI_VIRTUAL_TOOLS.length;
export const WEB_UI_STREAM_TOOL_COUNT = WEB_UI_VIRTUAL_TOOLS.filter((tool) => tool.stream).length;

const virtualToolsByName = new Map(WEB_UI_VIRTUAL_TOOLS.map((tool) => [tool.name, tool]));

export const getWebUiVirtualTool = (name: string): WebUiVirtualTool | undefined =>
  virtualToolsByName.get(name);

export const getWebUiVirtualToolDetail = (name: string): WebUiVirtualToolDetail | undefined => {
  const tool = getWebUiVirtualTool(name);
  if (!tool) return undefined;
  const rpc = rpcWithProps(tool.method);
  const isStream = RpcSchema.isStreamSchema(rpc.successSchema);
  const successSchema = isStream ? rpc.successSchema.success : rpc.successSchema;
  const errorSchema = isStream ? rpc.successSchema.error : rpc.errorSchema;
  return {
    ...tool,
    inputSchema: Tool.getJsonSchemaFromSchema(rpc.payloadSchema),
    successSchema: Tool.getJsonSchemaFromSchema(successSchema),
    errorSchema: Tool.getJsonSchemaFromSchema(errorSchema),
  };
};

export const isWebUiVirtualToolAuthorized = (
  tool: WebUiVirtualTool,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean => scopes.includes(tool.requiredScope);

export const webUiRpcDefinition = (method: WebUiRpcMethod): Rpc.AnyWithProps =>
  rpcWithProps(method);
