import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as NativeImageExecution from "./NativeImageExecution.ts";
import { NativeImageBindingRefused } from "./TurnBinding.ts";

const threadId = ThreadId.make("6825b7cc-4b34-48c0-9713-42b95cb866c3");
const itemId = "turn-item:provider:codex:native-item:call_0123456789abcdef";
type Runtime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type Input = Parameters<Runtime["startTurn"]>[0];

function fixture() {
  // These are lifecycle inputs, not a provider process or a native capture fixture.
  const runtime = {
    instanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("runtime-a"),
  } as Runtime;
  const input = {
    threadId,
    runId: `run:thread:${threadId}:ordinal:11`,
    runOrdinal: 11,
    providerThread: { id: "provider-thread-a" },
  } as Input;
  const scope: McpInvocationContext.McpInvocationScope = {
    principal: "provider-session",
    actorUserId: null,
    environmentId: EnvironmentId.make("synthetic-usm"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
    requestNamespace: "credential-a",
    thread: {
      threadId,
      providerInstanceId: runtime.instanceId,
      providerSessionId: "credential-a",
    },
    client: undefined,
  };
  return { runtime, input, scope };
}

const server = (port: number, host: string) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(host, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });

const testLayer = (port = 13773, host = "127.0.0.1") =>
  NativeImageExecution.layer.pipe(
    Layer.provide(Layer.succeed(HttpServer.HttpServer, server(port, host))),
    Layer.provide(Layer.succeed(HostProcess.Platform, "darwin")),
    Layer.provide(Layer.succeed(HostProcess.Username, "beknown")),
    Layer.provide(Layer.succeed(HostProcess.Hostname, "synthetic-usm")),
    Layer.provide(Layer.succeed(HostProcess.UserId, 501)),
  );

const unusedRpc = async () => {
  throw new Error("No RPC is expected in this lifecycle test");
};

it.effect("refuses a caller without an actual provider start, then binds its exact run", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeImageExecution.NativeImageExecution;
    expect(yield* service.bind(itemId, unusedRpc).pipe(Effect.flip)).toBeInstanceOf(
      NativeImageExecution.NativeImageExecutionRefused,
    );
    yield* service.started({ runtime: f.runtime, credentialId: "credential-a", input: f.input });
    const port = yield* service.bind(itemId, unusedRpc);
    expect(port.execution().run_id).toBe(f.input.runId);
    yield* service.terminal({
      runtime: f.runtime,
      providerThreadId: f.input.providerThread.id,
      runOrdinal: 11,
    });
    expect(() => port.execution()).toThrow(NativeImageBindingRefused);
  }).pipe(
    Effect.provide(testLayer()),
    Effect.provideService(McpInvocationContext.McpInvocationContext, f.scope),
  );
});

it.effect("does not let a late terminal event revoke the next run", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeImageExecution.NativeImageExecution;
    yield* service.started({ runtime: f.runtime, credentialId: "credential-a", input: f.input });
    const next = {
      ...f.input,
      runId: `run:thread:${threadId}:ordinal:12`,
      runOrdinal: 12,
    } as Input;
    yield* service.started({ runtime: f.runtime, credentialId: "credential-a", input: next });
    yield* service.terminal({
      runtime: f.runtime,
      providerThreadId: f.input.providerThread.id,
      runOrdinal: 11,
    });
    expect((yield* service.bind(itemId, unusedRpc)).execution().run_id).toBe(next.runId);
  }).pipe(
    Effect.provide(testLayer()),
    Effect.provideService(McpInvocationContext.McpInvocationContext, f.scope),
  );
});

it.effect("stops only the actual process, not a replacement with the same logical id", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeImageExecution.NativeImageExecution;
    const replacement = { ...f.runtime };
    yield* service.started({ runtime: f.runtime, credentialId: "credential-a", input: f.input });
    yield* service.started({ runtime: replacement, credentialId: "credential-a", input: f.input });
    yield* service.stopped(f.runtime);
    const port = yield* service.bind(itemId, unusedRpc);
    yield* service.stopped(replacement);
    expect(() => port.execution()).toThrow(NativeImageBindingRefused);
  }).pipe(
    Effect.provide(testLayer()),
    Effect.provideService(McpInvocationContext.McpInvocationContext, f.scope),
  );
});

it.effect("does not register a start without its actual MCP credential", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeImageExecution.NativeImageExecution;
    yield* service.started({ runtime: f.runtime, credentialId: undefined, input: f.input });
    expect(yield* service.bind(itemId, unusedRpc).pipe(Effect.flip)).toBeInstanceOf(
      NativeImageExecution.NativeImageExecutionRefused,
    );
  }).pipe(
    Effect.provide(testLayer()),
    Effect.provideService(McpInvocationContext.McpInvocationContext, f.scope),
  );
});

it.effect("uses the actual listener port instead of an origin supplied by the caller", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const service = yield* NativeImageExecution.NativeImageExecution;
    yield* service.started({ runtime: f.runtime, credentialId: "credential-a", input: f.input });
    expect(yield* service.bind(itemId, unusedRpc).pipe(Effect.flip)).toBeInstanceOf(
      NativeImageExecution.NativeImageExecutionRefused,
    );
  }).pipe(
    Effect.provide(testLayer(13774)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, f.scope),
  );
});

it.effect.each(["0.0.0.0", "::"])(
  "refuses the wildcard listener %s instead of asserting loopback ownership",
  (host) => {
    const f = fixture();
    return Effect.gen(function* () {
      const service = yield* NativeImageExecution.NativeImageExecution;
      yield* service.started({ runtime: f.runtime, credentialId: "credential-a", input: f.input });
      expect(yield* service.bind(itemId, unusedRpc).pipe(Effect.flip)).toBeInstanceOf(
        NativeImageExecution.NativeImageExecutionRefused,
      );
    }).pipe(
      Effect.provide(testLayer(13773, host)),
      Effect.provideService(McpInvocationContext.McpInvocationContext, f.scope),
    );
  },
);
