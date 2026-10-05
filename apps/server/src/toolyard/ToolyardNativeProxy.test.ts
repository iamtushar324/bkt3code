/** T3-CUSTOM(expbkt3): Native transport enforces the existing T3 owner boundary. */
// @effect-diagnostics nodeBuiltinImport:off
import { PassThrough } from "node:stream";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import { NodeHttpServer } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { AuthOrchestrationOperateScope, EnvironmentUserId, UserId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { runAcpMcpStdioBridge } from "../mcp/AcpMcpStdioBridge.ts";
import { makeNativeToolyardAuthenticator, makeNativeToolyardRoute } from "./ToolyardNativeHttp.ts";
import { nativeToolyardEndpoint, readNativeT3Token } from "./ToolyardNativeCli.ts";
import {
  makeNativeToolyardProxy,
  NATIVE_MCP_REQUEST_LIMIT,
  NATIVE_MCP_RESPONSE_LIMIT,
} from "./ToolyardNativeProxy.ts";

const request = (
  token = "paired-local-token",
  headers: Record<string, string> = {},
  body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
) =>
  new Request("https://bkt3.example/mcp/toolyard", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body,
  });

const authenticator = (
  local: boolean,
  userId: string | null = null,
  scopes: readonly string[] = [AuthOrchestrationOperateScope],
) =>
  makeNativeToolyardAuthenticator({
    resolveMcpCredential: async () => undefined,
    authenticateSession: async (incoming) => {
      if (incoming.headers.get("authorization") !== "Bearer paired-local-token")
        throw new Error("bad-token");
      return {
        subject: "real-paired-session",
        userId: userId ? EnvironmentUserId.make(userId) : null,
        sessionId: "paired-session-1",
        scopes,
      };
    },
    actorFor: (_subject, bound) => (bound ? Option.some(UserId.make(bound)) : Option.none()),
    isLocalOwner: async () => local,
  });

describe("native Toolyard owner auth", () => {
  it("uses local-user only for the authenticated no-Clerk profile", async () => {
    expect(await authenticator(true)(request())).toEqual({
      userId: "local-user",
      sessionId: "paired-session-1",
    });
    expect(await authenticator(false)(request())).toBeNull();
    await expect(authenticator(true)(request("wrong-token"))).rejects.toThrow("bad-token");
  });
  it("uses the paired user, ignores client identity headers, and denies read-only scopes", async () => {
    expect(
      await authenticator(
        false,
        "user_owner",
      )(request("paired-local-token", { "x-user-id": "user_other" })),
    ).toEqual({ userId: "user_owner", sessionId: "paired-session-1" });
    expect(await authenticator(false, "user_owner", ["orchestration:read"])(request())).toBeNull();
  });
  it("rejects server-wide legacy tokens even on local servers", async () => {
    let sessionCalls = 0;
    const auth = makeNativeToolyardAuthenticator({
      resolveMcpCredential: async () =>
        ({ principal: "external-operator", actorUserId: null }) as McpInvocationScope,
      authenticateSession: async () => {
        sessionCalls++;
        throw new Error("must-not-fallback");
      },
      actorFor: () => Option.none(),
      isLocalOwner: async () => true,
    });
    expect(await auth(request())).toBeNull();
    expect(sessionCalls).toBe(0);
  });
});

describe("native Toolyard proxy", () => {
  it("injects only the server credential and authoritative audit source", async () => {
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async (principal) => {
        expect(principal.userId).toBe("local-user");
        return { url: "https://toolyard.example/mcp", credential: "server-agent-token" };
      },
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://toolyard.example/mcp");
        expect(init?.redirect).toBe("manual");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer server-agent-token");
        expect(headers.get("cookie")).toBeNull();
        expect(headers.get("x-user-id")).toBeNull();
        expect(headers.get("x-bk-agent-session")).toBeNull();
        expect(headers.get("x-t3-session-id")).toBe("native:paired-session-1");
        expect(headers.get("x-t3-client-source")).toBe("native-client");
        expect(headers.get("x-toolyard-client")).toBe("cli");
        return Response.json(
          { result: "ok" },
          { headers: { "set-cookie": "forbidden", "x-upstream-secret": "forbidden" } },
        );
      },
    });
    const response = await proxy(
      request("paired-local-token", {
        cookie: "t3-cookie=secret",
        "x-user-id": "user_other",
        "x-bk-agent-session": "spoof",
        "x-t3-session-id": "spoof",
        "x-t3-client-source": "spoof",
      }),
    );
    expect(await response.json()).toEqual({ result: "ok" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream-secret")).toBeNull();
    expect(calls).toBe(1);
  });
  it("rechecks revocation and owner on every request without a cached credential", async () => {
    let revoked = false;
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(false, "user_owner"),
      connection: async ({ userId }) =>
        !revoked && userId === "user_owner"
          ? { url: "https://toolyard.example/mcp", credential: "owner-key" }
          : null,
      fetch: async () => {
        calls++;
        return Response.json({ result: "ok" });
      },
    });
    const first = await proxy(request());
    expect(first.status).toBe(200);
    await first.arrayBuffer();
    revoked = true;
    expect((await proxy(request())).status).toBe(403);
    expect(calls).toBe(1);
  });
  it("rejects ambient cookies and unauthorized users before any upstream request", async () => {
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(false),
      connection: async () => {
        calls++;
        return null;
      },
    });
    expect(
      (
        await proxy(
          new Request("https://bkt3.example/mcp/toolyard", {
            headers: { cookie: "authenticated-cookie" },
          }),
        )
      ).status,
    ).toBe(401);
    expect((await proxy(request())).status).toBe(401);
    expect(calls).toBe(0);
  });
  it("refuses redirects and does not retry dispatched writes after a timeout", async () => {
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async () => ({ url: "https://toolyard.example/mcp", credential: "key" }),
      fetch: async () => {
        calls++;
        throw new Error("upstream secret must not leak");
      },
    });
    const result = await proxy(request());
    expect(result.status).toBe(502);
    expect(await result.text()).toContain("toolyard-outcome-unknown");
    expect(calls).toBe(1);
    const redirect = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async () => ({ url: "https://toolyard.example/mcp", credential: "key" }),
      fetch: async () =>
        new Response(null, { status: 307, headers: { location: "https://other.example/mcp" } }),
    });
    expect((await redirect(request())).status).toBe(502);
  });
  it("bounds streamed request bodies and rate limits each user", async () => {
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async () => ({ url: "https://toolyard.example/mcp", credential: "key" }),
      fetch: async () => {
        calls++;
        return Response.json({ result: "ok" });
      },
    });
    expect(
      (await proxy(request("paired-local-token", {}, "x".repeat(NATIVE_MCP_REQUEST_LIMIT + 1))))
        .status,
    ).toBe(413);
    for (let index = 0; index < 59; index++) {
      const response = await proxy(request());
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    expect((await proxy(request())).status).toBe(429);
    expect(calls).toBe(59);
  });
  it("delivers an SSE event before upstream EOF and cancels the upstream reader", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = 0;
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async () => ({ url: "https://toolyard.example/mcp", credential: "key" }),
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              upstream = controller;
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const response = await proxy(request());
    const reader = response.body!.getReader();
    upstream!.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'));
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('"result":{}');
    expect(cancelled).toBe(0);
    await reader.cancel();
    expect(cancelled).toBe(1);
    expect(calls).toBe(1);
  });
  it("bounds streaming bytes, releases concurrency claims, and never retries", async () => {
    let cancelled = 0;
    let calls = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async () => ({ url: "https://toolyard.example/mcp", credential: "key" }),
      fetch: async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(NATIVE_MCP_RESPONSE_LIMIT + 1));
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    for (let index = 0; index < 5; index++) {
      const response = await proxy(request());
      expect(response.status).toBe(200);
      await expect(response.arrayBuffer()).rejects.toThrow("Inspect execution status");
    }
    expect(cancelled).toBe(5);
    expect(calls).toBe(5);
  });
  it("ends an idle SSE response at its deadline and cancels upstream once", async () => {
    let cancelled = 0;
    const proxy = makeNativeToolyardProxy({
      authenticate: authenticator(true),
      connection: async () => ({ url: "https://toolyard.example/mcp", credential: "key" }),
      timeoutMs: 10,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const response = await proxy(request());
    await expect(response.body!.getReader().read()).rejects.toThrow("Inspect execution status");
    expect(cancelled).toBe(1);
  });
});

it.effect("relays native stdio through the authenticated HTTP route for the local profile", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const owners: string[] = [];
      yield* HttpRouter.serve(
        makeNativeToolyardRoute({
          authenticate: authenticator(true),
          connection: async ({ userId }) => {
            owners.push(userId);
            return { url: "https://toolyard.example/mcp", credential: "host-owned-token" };
          },
          fetch: async (_url, init) => {
            const payload = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as {
              id?: number;
              method: string;
            };
            const headers = new Headers(init?.headers);
            expect(headers.get("authorization")).toBe("Bearer host-owned-token");
            return payload.id === undefined
              ? new Response(null, { status: 202 })
              : Response.json({
                  jsonrpc: "2.0",
                  id: payload.id,
                  result: { tools: [{ name: "inbox.status" }] },
                });
          },
        }),
        { disableListenLog: true, disableLogger: true },
      ).pipe(Layer.build);
      const server = yield* HttpServer.HttpServer;
      if (!("port" in server.address)) throw new Error("TCP required");
      const input = new PassThrough();
      let output = "";
      input.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
      yield* runAcpMcpStdioBridge({
        endpoint: `http://127.0.0.1:${server.address.port}/mcp/toolyard`,
        authorization: "Bearer paired-local-token",
        input,
        output: {
          write: (chunk) => {
            output += chunk;
          },
        },
      });
      expect(JSON.parse(output)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "inbox.status" }] },
      });
      expect(owners).toEqual(["local-user"]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

describe("native stdio setup", () => {
  it("permits HTTPS and loopback origins, rejects endpoint or credential substitution", () => {
    expect(nativeToolyardEndpoint("https://stagebkt3.dev.beknown.live/")).toBe(
      "https://stagebkt3.dev.beknown.live/mcp/toolyard",
    );
    expect(nativeToolyardEndpoint("http://127.0.0.1:3773")).toBe(
      "http://127.0.0.1:3773/mcp/toolyard",
    );
    for (const url of [
      "http://remote.example",
      "https://user:secret@server.example",
      "https://server.example/mcp",
      "https://server.example/?token=x",
    ])
      expect(() => nativeToolyardEndpoint(url)).toThrow();
  });
  it("reads an owner-only T3 token file and rejects readable files and symlinks", async () => {
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), "t3-native-key-"));
    try {
      const filename = Path.join(directory, "auth");
      await Fs.writeFile(filename, "synthetic-t3-token\n", { mode: 0o600 });
      expect(await readNativeT3Token(filename)).toBe("synthetic-t3-token");
      await Fs.chmod(filename, 0o644);
      await expect(readNativeT3Token(filename)).rejects.toThrow("owner-only");
      await Fs.chmod(filename, 0o600);
      await Fs.symlink(filename, Path.join(directory, "symlink"));
      await expect(readNativeT3Token(Path.join(directory, "symlink"))).rejects.toThrow();
    } finally {
      await Fs.rm(directory, { recursive: true, force: true });
    }
  });
});
