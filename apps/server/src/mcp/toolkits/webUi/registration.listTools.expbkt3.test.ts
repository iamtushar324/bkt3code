// T3-CUSTOM(expbkt3): TEC-1819 — an agent on the OAuth tool list (which has
// t3_ui_list_tools and t3_ui_call, not t3_ui_get_tool) can pick a web action
// and fill its input from t3_ui_list_tools alone, and the call schemas stay
// small.
import { expect, it } from "@effect/vitest";
import { EnvironmentId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import { makeWebUiRpcHandlers, WebUiRpcToolkit } from "./registration.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "external-user",
  actorUserId: UserId.make("user-web-ui-list-tools-test"),
  environmentId: EnvironmentId.make("environment-web-ui-list-tools-test"),
  requestNamespace: "external-user:user-web-ui-list-tools-test",
  thread: undefined,
  client: {
    sessionId: "external-user:user-web-ui-list-tools-test",
    label: "External MCP user",
    access: "full-access",
  },
  capabilities: new Set(["orchestration", "t3.read", "t3.control"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "web-ui-list-tools-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "web-ui-list-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const handlers = makeWebUiRpcHandlers(() => Effect.die("no virtual call runs in these tests"));
const TestLayer = McpHttpServer.toolkitRegistration(WebUiRpcToolkit, handlers).pipe(
  Layer.provide(liveThreadsLayer),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const withInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

interface ListedTool {
  readonly name: string;
  readonly description: string;
  readonly requiredFields: ReadonlyArray<string>;
  readonly inputSchema?: unknown;
}

it.effect("lists compact entries with a description and required fields", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const listed = yield* withInvocation(
        server.callTool({ name: "t3_ui_list_tools", arguments: { query: "read_file" } }),
      );
      expect(listed.isError).toBe(false);
      const tools = (listed.structuredContent as { tools: ReadonlyArray<ListedTool> }).tools;
      const readFile = tools.find((tool) => tool.name === "t3_ui_projects_read_file");
      expect(readFile?.description).toBe("Read a file in a project.");
      expect(readFile?.requiredFields).toEqual(expect.arrayContaining(["cwd", "relativePath"]));
      expect(readFile).not.toHaveProperty("inputSchema");
      for (const tool of tools) expect(Array.isArray(tool.requiredFields)).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("returns the input schema of named tools, so no t3_ui_get_tool call is needed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const listed = yield* withInvocation(
        server.callTool({
          name: "t3_ui_list_tools",
          arguments: { tools: ["t3_ui_projects_read_file"] },
        }),
      );
      expect(listed.isError).toBe(false);
      const [tool] = (listed.structuredContent as { tools: ReadonlyArray<ListedTool> }).tools;
      expect(tool?.name).toBe("t3_ui_projects_read_file");
      expect(JSON.stringify(tool?.inputSchema)).toContain("relativePath");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses an unknown name with the closest real names", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const listed = yield* withInvocation(
        server.callTool({
          name: "t3_ui_list_tools",
          arguments: { tool: "t3_ui_projects_readfile" },
        }),
      );
      expect(listed.isError).toBe(true);
      expect(JSON.stringify(listed.content)).toContain("t3_ui_projects_read_file");

      const call = yield* withInvocation(
        server.callTool({ name: "t3_ui_call", arguments: { tool: "t3_ui_projects_readfile" } }),
      );
      expect(call.isError).toBe(true);
      expect(JSON.stringify(call.content)).toContain("Closest: t3_ui_projects_read_file");
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps the call schemas free of the full virtual tool list", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      for (const { tool } of server.tools) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toContain("t3_ui_projects_list_entries");
        expect(schema.length).toBeLessThan(4000);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
