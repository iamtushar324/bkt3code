import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as McpUpstreamProxy from "./McpUpstreamProxy.ts";

it.effect("forwards streamed MCP request bodies with per-user Bifrost authentication", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(
        HttpRouter.add(
          "POST",
          "/upstream",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const payload = yield* request.json;
            return HttpServerResponse.jsonUnsafe({
              payload,
              virtualKey: request.headers["x-bf-vk"],
            });
          }),
        ),
        {
          disableListenLog: true,
          disableLogger: true,
        },
      ).pipe(Layer.build);

      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
            ),
          );
          controller.close();
        },
      });
      const incoming = new Request("http://127.0.0.1/mcp/upstream/bifrost", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit);
      const outgoing = yield* McpUpstreamProxy.__testing.makeForwardedRequest(incoming, {
        url: "/upstream",
        authMode: "x-bf-vk",
        customHeaderName: "",
        credential: "vk-user-test",
      });
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(outgoing);
      const payload = yield* response.json;

      expect(response.status).toBe(200);
      expect(payload).toEqual({
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        virtualKey: "vk-user-test",
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
