/** T3-CUSTOM(expbkt3): Verify discovery, cached calls, and live changes through the MCP transport. */
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import { ServerSettingsService } from "../../../serverSettings.ts";
import { registerWithPlanSubmissionGate } from "./planSubmissionGate.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const responseSchema = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      tools: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
      content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    }),
  ),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
});

it.effect("hides the default-off tool and rejects cached calls across live setting changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let currentSettings = DEFAULT_SERVER_SETTINGS;
      const changes = yield* PubSub.unbounded<typeof currentSettings>();
      const notifications = yield* Queue.unbounded<void>();
      let submissions = 0;
      const settingsService = ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.sync(() => currentSettings),
        updateSettings: () => Effect.die("unused"),
        streamChanges: Stream.empty,
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
      const registration = Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const registerTools = Effect.gen(function* () {
          const gatedServer = yield* McpServer.McpServer;
          yield* Effect.forEach(["t3_submit_plan", "t3_list_plannotator_reviews"], (name) =>
            gatedServer.addTool({
              tool: new McpSchema.Tool({ name, inputSchema: { type: "object" } }),
              annotations: Context.empty(),
              handle: () =>
                Effect.sync(() => {
                  if (name === "t3_submit_plan") submissions += 1;
                  return new McpSchema.CallToolResult({
                    content: [{ type: "text", text: "accepted" }],
                  });
                }),
            }),
          );
        });
        yield* registerWithPlanSubmissionGate(registerTools).pipe(
          Effect.provideService(ServerSettingsService, settingsService),
          Effect.provideService(McpServer.McpServer, {
            ...server,
            notifications: {
              ...server.notifications,
              "notifications/tools/list_changed": () =>
                Queue.offer(notifications, undefined).pipe(Effect.asVoid),
            },
          }),
        );
      });
      const transport = McpServer.layerHttp({
        name: "Plan submission experiment test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      const serverLayer = Layer.effectDiscard(registration).pipe(Layer.provideMerge(transport));
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;
      const initialized = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          encodeJson({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      const sessionId = initialized.headers["mcp-session-id"]!;
      expect(initialized.status).toBe(200);
      yield* initialized.text;
      let requestId = 1;
      const request = Effect.fn("test.mcpRequest")(function* (method: string, params = {}) {
        const response = yield* httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-06-18",
          },
          body: HttpBody.text(
            encodeJson({ jsonrpc: "2.0", id: ++requestId, method, params }),
            "application/json",
          ),
        });
        const data = yield* response.json;
        return yield* Schema.decodeUnknownEffect(responseSchema)(data);
      });
      const listedBefore = yield* request("tools/list");
      expect(listedBefore.result?.tools?.map((tool) => tool.name)).toEqual([
        "t3_list_plannotator_reviews",
      ]);
      const disabledCall = yield* request("tools/call", { name: "t3_submit_plan", arguments: {} });
      expect(disabledCall.error?.message).toContain("not found");
      expect(submissions).toBe(0);
      const existingReviews = yield* request("tools/call", {
        name: "t3_list_plannotator_reviews",
        arguments: {},
      });
      expect(existingReviews.result?.content).toBeDefined();

      currentSettings = {
        ...currentSettings,
        experimental: { ...currentSettings.experimental, planSubmissionToolEnabled: true },
      };
      yield* PubSub.publish(changes, currentSettings);
      yield* Queue.take(notifications);
      const listedEnabled = yield* request("tools/list");
      expect(listedEnabled.result?.tools?.map((tool) => tool.name)).toContain("t3_submit_plan");
      const enabledCall = yield* request("tools/call", { name: "t3_submit_plan", arguments: {} });
      expect(enabledCall.result?.content).toBeDefined();
      expect(submissions).toBe(1);

      currentSettings = {
        ...currentSettings,
        experimental: { ...currentSettings.experimental, planSubmissionToolEnabled: false },
      };
      yield* PubSub.publish(changes, currentSettings);
      yield* Queue.take(notifications);
      const cachedCall = yield* request("tools/call", { name: "t3_submit_plan", arguments: {} });
      expect(cachedCall.error?.message).toContain("not found");
      expect(submissions).toBe(1);
      expect((yield* request("tools/list")).result?.tools?.map((tool) => tool.name)).toEqual([
        "t3_list_plannotator_reviews",
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
