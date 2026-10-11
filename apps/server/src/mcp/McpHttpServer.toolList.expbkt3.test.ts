import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccess from "./McpToolAccess.ts";

const environmentId = EnvironmentId.make("environment-tool-list");
const providerToken = "providerTokenWithoutDots";
const clientToken = "client-payload.client-signature";

const providerScope: McpInvocationContext.McpInvocationScope = {
  principal: "provider-session",
  actorUserId: null,
  environmentId,
  requestNamespace: "provider-session",
  thread: {
    threadId: ThreadId.make("thread-provider"),
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const clientScope: McpInvocationContext.McpInvocationScope = {
  principal: "external-user",
  actorUserId: null,
  environmentId,
  requestNamespace: "client:session-1",
  thread: undefined,
  client: { sessionId: "session-1", label: "Claude Desktop", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const probe = <const Name extends string>(name: Name) =>
  Tool.make(name, {
    description: "Probe.",
    success: Schema.Struct({ ok: Schema.Boolean }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  });

// One tool on the OAuth client's short list, one only on the full list.
const ProbeToolkit = Toolkit.make(probe("t3_wait"), probe("t3_list_sessions"));

const JsonRpcReply = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    instructions: Schema.optional(Schema.String),
  }),
});
const decodeReply = Schema.decodeUnknownSync(Schema.fromJsonString(JsonRpcReply));

/** A JSON-RPC reply body, sent as JSON or as one server-sent event. */
const replyOf = (text: string) =>
  decodeReply(
    text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join(""),
  );

it.effect("lists only the agent tools to an OAuth client unless it asks for every tool", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          t3_wait: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
          t3_list_sessions: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
        }),
      ).pipe(
        Layer.provideMerge(McpHttpServer.layerMcpTransport),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) =>
              Effect.succeed(
                token === providerToken
                  ? (providerScope as McpInvocationContext.McpThreadInvocationScope)
                  : undefined,
              ),
          }),
        ),
        Layer.provide(
          Layer.succeed(McpHttpServer.McpClientAuthenticator, {
            authenticate: (request) =>
              Effect.succeed(
                request.headers.authorization === `Bearer ${clientToken}` ? clientScope : undefined,
              ),
          }),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const connect = (token: string, extra: Record<string, string> = {}) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            ...extra,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const instructions = replyOf(yield* initialize.text).result.instructions;
          const listed = yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
              "application/json",
            ),
          });
          const tools = (replyOf(yield* listed.text).result.tools ?? [])
            .map((tool) => tool.name)
            .toSorted();
          return { instructions, tools };
        });

      const agent = yield* connect(providerToken);
      expect(agent.tools).toEqual(["t3_list_sessions", "t3_wait"]);
      expect(agent.instructions).toContain("t3_inbox");

      expect((yield* connect(clientToken)).tools).toEqual(["t3_wait"]);
      expect((yield* connect(clientToken, { "x-t3-mcp-tools": "all" })).tools).toEqual([
        "t3_list_sessions",
        "t3_wait",
      ]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
