import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  BIFROST_MCP_URL,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TOOLYARD_MCP_URL,
  UserId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpUpstreamProxy from "./McpUpstreamProxy.ts";

const threadId = ThreadId.make("thread-upstream-proxy-test");

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
              t3SessionId: request.headers["x-t3-session-id"],
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
        headers: { "content-type": "application/json", "x-t3-session-id": "spoofed" },
        body,
        duplex: "half",
      } as RequestInit);
      const outgoing = yield* McpUpstreamProxy.__testing.makeForwardedRequest(incoming, {
        url: "/upstream",
        authMode: "x-bf-vk",
        customHeaderName: "",
        credential: "vk-user-test",
        threadId,
      });
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.execute(outgoing);
      const payload = yield* response.json;

      expect(response.status).toBe(200);
      expect(payload).toEqual({
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        virtualKey: "vk-user-test",
      });
      expect(payload).not.toHaveProperty("t3SessionId");
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const forwardTo = (url: string) =>
  McpUpstreamProxy.__testing.makeForwardedRequest(
    new Request("http://127.0.0.1/mcp/upstream/bifrost", {
      method: "POST",
      headers: { "content-type": "application/json", "x-t3-session-id": "spoofed" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
    { url, authMode: "x-bf-vk", customHeaderName: "", credential: "vk-user-test", threadId },
  );

it.effect("names the T3 thread to the toolyard gateway", () =>
  Effect.gen(function* () {
    const outgoing = yield* forwardTo(TOOLYARD_MCP_URL);

    expect(outgoing.headers["x-t3-session-id"]).toBe(threadId);
    expect(outgoing.headers["x-bf-vk"]).toBe("vk-user-test");
  }),
);

it.effect("does not name the T3 thread to the stock Bifrost gateway", () =>
  Effect.gen(function* () {
    const outgoing = yield* forwardTo(BIFROST_MCP_URL);

    expect(outgoing.headers).not.toHaveProperty("x-t3-session-id");
    expect(outgoing.headers["x-bf-vk"]).toBe("vk-user-test");
  }),
);

it.effect("sends the toolyard bearer token and names the T3 thread to toolyard", () =>
  Effect.gen(function* () {
    const outgoing = yield* McpUpstreamProxy.__testing.makeForwardedRequest(
      new Request("http://127.0.0.1/mcp/upstream/toolyard", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-t3-session-id": "spoofed",
          cookie: "t3_session=browser-cookie",
          authorization: "Bearer provider-run-token",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      }),
      {
        url: TOOLYARD_MCP_URL,
        authMode: "bearer",
        customHeaderName: "",
        credential: "ty_agent_token",
        threadId,
      },
    );

    expect(outgoing.headers.authorization).toBe("Bearer ty_agent_token");
    expect(outgoing.headers["x-t3-session-id"]).toBe(threadId);
    expect(outgoing.headers).not.toHaveProperty("cookie");
    expect(outgoing.headers).not.toHaveProperty("x-bf-vk");
  }),
);

describe("shouldRetireUpstreamCredential", () => {
  it("retires only toolyard's credential, and only on a 401", () => {
    expect(McpUpstreamProxy.shouldRetireUpstreamCredential("toolyard", 401)).toBe(true);
    expect(McpUpstreamProxy.shouldRetireUpstreamCredential("toolyard", 403)).toBe(false);
    expect(McpUpstreamProxy.shouldRetireUpstreamCredential("toolyard", 502)).toBe(false);
    expect(McpUpstreamProxy.shouldRetireUpstreamCredential("bifrost", 401)).toBe(false);
    expect(McpUpstreamProxy.shouldRetireUpstreamCredential("custom-tools", 401)).toBe(false);
  });
});

it.effect("sends no T3 thread to toolyard for a personal-token call", () =>
  Effect.gen(function* () {
    const outgoing = yield* McpUpstreamProxy.__testing.makeForwardedRequest(
      new Request("http://127.0.0.1/mcp/upstream/toolyard", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-t3-session-id": "spoofed",
          authorization: "Bearer t3usr_personal",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}',
      }),
      {
        url: TOOLYARD_MCP_URL,
        authMode: "bearer",
        customHeaderName: "",
        credential: "ty_agent_token",
        threadId: null,
        integrationId: "toolyard",
      },
    );

    expect(outgoing.headers.authorization).toBe("Bearer ty_agent_token");
    expect(outgoing.headers).not.toHaveProperty("x-t3-session-id");
  }),
);

describe("upstreamCallerFor", () => {
  const tushar = UserId.make("user_tushar");
  const scope = (overrides: Partial<McpInvocationScope>): McpInvocationScope => ({
    principal: "external-user",
    actorUserId: tushar,
    environmentId: EnvironmentId.make("env_test"),
    capabilities: new Set(),
    issuedAt: 0,
    requestNamespace: `external-user:${tushar}`,
    thread: undefined,
    client: {
      sessionId: `external-user:${tushar}`,
      label: "External MCP user",
      access: "full-access",
    },
    ...overrides,
  });
  const providerThread = {
    threadId,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("claude"),
  };

  it("acts as the token's own user for a personal token on toolyard, with no thread", () => {
    expect(McpUpstreamProxy.upstreamCallerFor(scope({}), "toolyard", "t3usr_abc")).toEqual({
      kind: "personal-token",
      actorUserId: tushar,
    });
  });

  it("refuses a personal token on every integration other than toolyard", () => {
    expect(McpUpstreamProxy.upstreamCallerFor(scope({}), "bifrost", "t3usr_abc")).toBeNull();
  });

  it("refuses an unresolved token, so a disabled switch or revoked token gets a 401", () => {
    expect(McpUpstreamProxy.upstreamCallerFor(undefined, "toolyard", "t3usr_abc")).toBeNull();
  });

  it("refuses the shared operator key and external scopes that are not personal tokens", () => {
    expect(
      McpUpstreamProxy.upstreamCallerFor(
        scope({
          principal: "external-operator",
          actorUserId: null,
          requestNamespace: "external-operator",
        }),
        "toolyard",
        "operator-key-that-is-long-enough",
      ),
    ).toBeNull();
    expect(
      McpUpstreamProxy.upstreamCallerFor(scope({}), "toolyard", "oauth-access-token"),
    ).toBeNull();
    expect(
      McpUpstreamProxy.upstreamCallerFor(scope({ actorUserId: null }), "toolyard", "t3usr_abc"),
    ).toBeNull();
  });

  it("never lets a personal scope name a different user than its own token row", () => {
    expect(
      McpUpstreamProxy.upstreamCallerFor(
        scope({ requestNamespace: "external-user:user_someone_else" }),
        "toolyard",
        "t3usr_abc",
      ),
    ).toBeNull();
  });

  it("keeps the provider-session path: its user and its thread", () => {
    expect(
      McpUpstreamProxy.upstreamCallerFor(
        scope({ principal: "provider-session", thread: providerThread, client: undefined }),
        "toolyard",
        "acp-token",
      ),
    ).toEqual({
      kind: "provider-session",
      actorUserId: tushar,
      threadId,
      providerInstanceId: providerThread.providerInstanceId,
      providerSessionId: providerThread.providerSessionId,
    });
    expect(
      McpUpstreamProxy.upstreamCallerFor(
        scope({ principal: "provider-session", thread: undefined, client: undefined }),
        "toolyard",
        "acp-token",
      ),
    ).toBeNull();
  });
});
