/**
 * T3-CUSTOM(expbkt3): Compact, generated catalog for every authenticated web
 * RPC. The four real MCP tools expose these virtual tools without injecting a
 * hundred large schemas into every provider prompt.
 */
import { type AuthEnvironmentScope, WsRpcGroup } from "@t3tools/contracts";
import { Tool } from "effect/ai";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSchema from "effect/rpc/RpcSchema";

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
  // T3-CUSTOM(expbkt3): TEC-1819 — the payload's required fields.
  readonly requiredFields: ReadonlyArray<string>;
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

/**
 * The schema half of an RPC definition. `Rpc.AnyWithProps` also erases the
 * middleware set, and the group's `RpcScopeAuthorization` (which provides no
 * services) is not assignable to its erased middleware type.
 */
export type WebUiRpcDefinition = Pick<
  Rpc.AnyWithProps,
  "payloadSchema" | "successSchema" | "errorSchema"
>;

const rpcWithProps = (method: WebUiRpcMethod): WebUiRpcDefinition => {
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
    ...webUiVirtualToolSummary(tool),
    inputSchema: Tool.getJsonSchemaFromSchema(rpc.payloadSchema),
    successSchema: Tool.getJsonSchemaFromSchema(successSchema),
    errorSchema: Tool.getJsonSchemaFromSchema(errorSchema),
  };
};

// T3-CUSTOM(expbkt3): TEC-1819 — one-line descriptions and required fields so
// an agent can pick a virtual tool and fill it from t3_ui_list_tools alone.

/** Plain descriptions of the actions agents reach for most. */
const METHOD_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "orchestration.dispatchCommand":
    "Dispatch one orchestration command. To archive, unarchive, stop, snooze or delete a session, use t3_session_lifecycle instead.",
  "orchestration.launchThread": "Start a new session in a project.",
  "orchestration.searchThreads": "Search sessions by text.",
  "orchestration.searchThread": "Search the messages of one session.",
  "orchestration.getArchivedShellSnapshot": "List archived sessions.",
  "orchestration.getThreadProjection": "Read one session's full state.",
  "orchestration.getTurnDiff": "Read the file changes of one turn.",
  "orchestration.getFullThreadDiff": "Read all file changes of a session.",
  "orchestration.stopWorkflow": "Stop a running workflow.",
  "projects.list": "List projects.",
  "projects.add": "Add a project from a folder.",
  "projects.remove": "Remove a project.",
  "projects.listEntries": "List files and folders in a project.",
  "projects.readFile": "Read a file in a project.",
  "projects.writeFile": "Write a file in a project.",
  "projects.searchEntries": "Find files and folders in a project by name.",
  "projects.searchContents": "Search the text of files in a project.",
  "server.getConfig": "Read the server configuration: providers, models and keybindings.",
  "server.getSettings": "Read the server settings.",
  "server.updateSettings": "Change server settings with a partial patch.",
  "scheduledTasks.list": "List scheduled tasks.",
  "scheduledTasks.upsert": "Add or change a scheduled task.",
  "scheduledTasks.delete": "Delete a scheduled task.",
  "scheduledTasks.runNow": "Run a scheduled task now.",
  "scheduledTasks.setEnabled": "Turn a scheduled task on or off.",
  "pullRequests.list": "List pull requests.",
  "pullRequests.detail": "Read one pull request.",
  "pullRequests.checks": "Read the CI checks of a pull request.",
  "pullRequests.comment": "Comment on a pull request.",
  "vcs.createWorktree": "Make a git worktree.",
  "vcs.removeWorktree": "Remove a git worktree.",
  "vcs.listRefs": "List git branches.",
  "vcs.pull": "Pull the current branch.",
  "terminal.open": "Open a terminal in a session's workspace.",
  "terminal.write": "Type into an open terminal.",
  "terminal.close": "Close a terminal.",
  "threadComments.list": "List review comments on a session's messages.",
  "threadComments.add": "Add a review comment to a session's message.",
  "users.list": "List T3 users.",
  "linearIssues.resolve": "Look up a Linear issue by key or URL.",
  "planReview.get": "Read a plan under review.",
  "planReview.list": "List plans under review.",
  "planReview.submit": "Submit a plan review decision.",
  "preview.open": "Open a browser preview.",
  "preview.list": "List open browser previews.",
  "preview.close": "Close a browser preview.",
};

type JsonObject = { readonly [key: string]: unknown };

const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The payload's top-level object schema, through a `$ref` into `$defs`. */
const payloadObjectSchema = (method: WebUiRpcMethod): JsonObject => {
  const root = Tool.getJsonSchemaFromSchema(rpcWithProps(method).payloadSchema) as unknown;
  if (!isJsonObject(root)) return {};
  const defs = isJsonObject(root.$defs) ? root.$defs : {};
  let node: JsonObject = root;
  for (let depth = 0; depth < 4; depth += 1) {
    const ref = node.$ref;
    if (typeof ref !== "string") break;
    const target = defs[ref.replace(/^#\/\$defs\//, "")];
    if (!isJsonObject(target)) break;
    node = target;
  }
  return node;
};

interface WebUiVirtualToolSummary {
  readonly description: string;
  readonly requiredFields: ReadonlyArray<string>;
}

const summaries = new Map<string, WebUiVirtualToolSummary>();

/**
 * A one-line description (the payload schema's own description, else a
 * hand-written one, else the generic text) and the payload's required fields.
 * Computed on first use and cached: the JSON Schema is not free to build.
 */
export const webUiVirtualToolSummary = (tool: WebUiVirtualTool): WebUiVirtualToolSummary => {
  const cached = summaries.get(tool.name);
  if (cached) return cached;
  let schema: JsonObject = {};
  try {
    schema = payloadObjectSchema(tool.method);
  } catch {
    schema = {};
  }
  const annotated =
    typeof schema.description === "string" && schema.description.trim().length > 0
      ? schema.description.trim()
      : undefined;
  const summary: WebUiVirtualToolSummary = {
    description: annotated ?? METHOD_DESCRIPTIONS[tool.method] ?? tool.description,
    requiredFields: Array.isArray(schema.required)
      ? schema.required.filter((field): field is string => typeof field === "string")
      : [],
  };
  summaries.set(tool.name, summary);
  return summary;
};
// T3-CUSTOM(expbkt3): END

export const isWebUiVirtualToolAuthorized = (
  tool: WebUiVirtualTool,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean => scopes.includes(tool.requiredScope);

export const webUiRpcDefinition = (method: WebUiRpcMethod): WebUiRpcDefinition =>
  rpcWithProps(method);
