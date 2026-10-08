import { expect, it } from "@effect/vitest";
import { EnvironmentId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";
import type { WebUiRpcCallRequest } from "./bridge.ts";
import { makeWebUiRpcHandlers, WEB_UI_MCP_TOOL_NAMES, WebUiRpcToolkit } from "./registration.ts";

const invocation: McpInvocationContext.McpInvocationScope = {
  principal: "external-user",
  actorUserId: UserId.make("user-web-ui-registration-test"),
  environmentId: EnvironmentId.make("environment-web-ui-registration-test"),
  requestNamespace: "external-user:user-web-ui-registration-test",
  thread: undefined,
  client: {
    sessionId: "external-user:user-web-ui-registration-test",
    label: "External MCP user",
    access: "full-access",
  },
  capabilities: new Set(["orchestration", "t3.read", "t3.control"]),
  issuedAt: 1,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  // T3-CUSTOM(expbkt3): upstream promoted these off initializePayload onto the client.
  clientCapabilities: {},
  clientInfo: { name: "web-ui-registration-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "web-ui-registration-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const calls: Array<ReadonlyArray<WebUiRpcCallRequest>> = [];
// Registered the production way: McpToolAccess checks run before the bridge.
const handlers = makeWebUiRpcHandlers((_scope, requests) => {
  calls.push(requests);
  return Effect.succeed(
    requests.map((request, index) => ({
      ok: true as const,
      ...(request.id === undefined ? {} : { id: request.id }),
      index,
      tool: request.tool,
      method: request.method,
      stream: false as const,
      result: { echoed: request.input ?? null },
    })),
  );
});
const TestLayer = McpHttpServer.toolkitRegistration(WebUiRpcToolkit, handlers).pipe(
  Layer.provide(liveThreadsLayer),
  Layer.provideMerge(McpServer.McpServer.layer),
);

const withInvocation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    Effect.provideService(McpSchema.McpServerClient, client),
  );

it.effect("registers four compact tools while listing the complete virtual surface", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual(
        [...WEB_UI_MCP_TOOL_NAMES].toSorted(),
      );

      const listed = yield* withInvocation(
        server.callTool({ name: "t3_ui_list_tools", arguments: {} }),
      );
      expect(listed.isError).toBe(false);
      expect(listed.structuredContent).toMatchObject({
        ok: true,
        // T3-CUSTOM(expbkt3): registration exposes native V2 methods and all retained fork RPCs.
        rpcCount: 230,
        streamCount: 30,
        matchedCount: 230,
      });

      const schema = yield* withInvocation(
        server.callTool({
          name: "t3_ui_get_tool",
          arguments: { tool: "t3_ui_server_get_config" },
        }),
      );
      expect(schema.structuredContent).toMatchObject({
        ok: true,
        tool: {
          name: "t3_ui_server_get_config",
          method: "server.getConfig",
          authorized: true,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("routes single and batch virtual calls through the injected executor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      calls.length = 0;
      const server = yield* McpServer.McpServer;
      const single = yield* withInvocation(
        server.callTool({
          name: "t3_ui_call",
          arguments: {
            tool: "t3_ui_server_get_config",
            input: {},
          },
        }),
      );
      expect(single.isError).toBe(false);
      expect(single.structuredContent).toMatchObject({
        ok: true,
        tool: "t3_ui_server_get_config",
        method: "server.getConfig",
      });

      const batch = yield* withInvocation(
        server.callTool({
          name: "t3_ui_batch",
          arguments: {
            calls: [
              { id: "config", tool: "t3_ui_server_get_config", input: {} },
              { id: "projects", tool: "t3_ui_projects_list_entries", input: {} },
            ],
          },
        }),
      );
      expect(batch.isError).toBe(false);
      expect(batch.structuredContent).toMatchObject({
        ok: true,
        requestedCount: 2,
        completedCount: 2,
        failedCount: 0,
      });
      expect(calls).toHaveLength(2);
      expect(calls[1]?.map((call) => call.method)).toEqual([
        "server.getConfig",
        "projects.listEntries",
      ]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
