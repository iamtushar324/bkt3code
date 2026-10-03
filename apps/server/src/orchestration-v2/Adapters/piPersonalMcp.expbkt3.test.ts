/** T3-CUSTOM(expbkt3): exercise the shipped Pi bridge with actor-bound personal MCP servers. */
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type Tool = {
  readonly name: string;
  readonly execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ readonly details: { readonly server: string; readonly mcpResult: unknown } }>;
};
type SessionHook = (
  event: unknown,
  context: { readonly ui: { readonly notify: (message: string, type: string) => void } },
) => Promise<void>;
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ method: Schema.String, id: Schema.optional(Schema.Number) }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it("keeps working servers, retries only failed profiles, and retains structured render handles", async () => {
  const registered: Array<Tool> = [];
  const hooks = new Map<string, SessionHook>();
  const calls: Array<{ endpoint: string; authorization: string; method: string }> = [];
  let personalAvailable = false;
  const uiResult = {
    content: [{ type: "text", text: "ready" }],
    structuredContent: { t3Ui: { renderId: "render-personal", kind: "html", height: 240 } },
  };
  const fetchStub = async (
    endpoint: string,
    init: { readonly body: string; readonly headers: Record<string, string> },
  ) => {
    const request = decodeRequest(init.body);
    calls.push({ endpoint, authorization: init.headers.authorization!, method: request.method });
    if (endpoint === "https://mcp/personal" && !personalAvailable)
      return new Response("unavailable", { status: 503 });
    const result =
      request.method === "tools/list"
        ? {
            tools: [
              { name: "show", description: "Show a result", inputSchema: { type: "object" } },
            ],
          }
        : request.method === "tools/call"
          ? uiResult
          : {};
    return new Response(
      encodeJson({
        jsonrpc: "2.0",
        ...(request.id === undefined ? {} : { id: request.id }),
        result,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: {
        T3_MCP_URL: "https://mcp/t3",
        T3_MCP_BEARER_TOKEN: "Bearer actor-a",
        T3_PI_PERSONAL_MCP:
          '[{"name":"bifrost","endpoint":"https://mcp/personal"},{"name":"toolyard","endpoint":"https://mcp/toolyard"}]',
      },
    },
    pi: {
      on: (name: string, hook: SessionHook) => hooks.set(name, hook),
      registerTool: (tool: Tool) => registered.push(tool),
    },
    Type: { Unsafe: (schema: unknown) => schema },
    fetch: fetchStub,
    AbortSignal,
  });
  expect(registered.map((tool) => tool.name)).toEqual([
    "mcp__t3-code__show",
    "mcp__toolyard__show",
  ]);
  personalAvailable = true;
  await hooks.get("session_start")!(undefined, { ui: { notify: () => undefined } });
  expect(registered.map((tool) => tool.name)).toEqual([
    "mcp__t3-code__show",
    "mcp__toolyard__show",
    "mcp__bifrost__show",
  ]);
  const result = await registered
    .find((tool) => tool.name === "mcp__bifrost__show")!
    .execute("call-1", {});
  expect(result.details).toEqual({ server: "bifrost", tool: "show", mcpResult: uiResult });
  expect(calls.every((call) => call.authorization === "Bearer actor-a")).toBe(true);
  expect(
    calls.filter((call) => call.endpoint === "https://mcp/t3" && call.method === "initialize"),
  ).toHaveLength(1);
  expect(
    calls.filter(
      (call) => call.endpoint === "https://mcp/toolyard" && call.method === "initialize",
    ),
  ).toHaveLength(1);
});
