/** T3-CUSTOM(expbkt3): Optional internal execution service; not installed in the production layer. */
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { NativeImageTurnBindings } from "./TurnBinding.ts";

type Runtime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type TurnInput = Parameters<Runtime["startTurn"]>[0];
type Port = ReturnType<NativeImageTurnBindings["bind"]>;
type Rpc = Parameters<NativeImageTurnBindings["bind"]>[3];
type Started = {
  readonly runtime: Runtime;
  readonly credentialId: string | undefined;
  readonly input: TurnInput;
};
type Terminal = {
  readonly runtime: Runtime;
  readonly providerThreadId: string;
  readonly runOrdinal: number;
};

export class NativeImageExecutionRefused extends Schema.TaggedError<NativeImageExecutionRefused>()(
  "NativeImageExecutionRefused",
  {},
) {
  override get message() {
    return "The current native image execution context could not be established.";
  }
}

export class NativeImageExecution extends Context.Service<
  NativeImageExecution,
  {
    readonly started: (input: Started) => Effect.Effect<void>;
    readonly terminal: (input: Terminal) => Effect.Effect<void>;
    readonly stopped: (runtime: Runtime) => Effect.Effect<void>;
    readonly bind: (
      itemId: string,
      rpc: Rpc,
    ) => Effect.Effect<
      Port,
      NativeImageExecutionRefused,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/nativeImageExport/NativeImageExecution") {}

const make = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const platform = yield* HostProcess.Platform;
  const user = yield* HostProcess.Username;
  const hostname = yield* HostProcess.Hostname;
  const uid = yield* HostProcess.UserId;
  const address = server.address;
  const local =
    NetAddress.isInetAddress(address) && NetAddress.formatIp(address.address) === "127.0.0.1";
  const origin = local ? `http://127.0.0.1:${address.port}` : "";
  const bindings = new NativeImageTurnBindings();
  const leases = new WeakMap<Runtime, Map<string, { readonly close: () => void }>>();
  const key = (providerThreadId: string, ordinal: number) => `${providerThreadId}\0${ordinal}`;

  // Lifecycle callbacks already run inside provider-session spans and do no I/O.
  const started = Effect.fnUntraced(function* ({ runtime, credentialId, input }: Started) {
    yield* Effect.sync(() => {
      if (
        runtime.instanceId !== "codex" ||
        credentialId === undefined ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.threadId)
      )
        return;
      const active = leases.get(runtime) ?? new Map<string, { readonly close: () => void }>();
      const turnKey = key(input.providerThread.id, input.runOrdinal);
      active.get(turnKey)?.close();
      const lease = bindings.open({
        threadId: input.threadId,
        runId: input.runId,
        providerInstanceId: runtime.instanceId,
        credentialId,
        runtimeSessionId: runtime.providerSessionId,
        runtimeIdentity: runtime,
      });
      active.set(turnKey, lease);
      leases.set(runtime, active);
    });
  });

  const terminal = Effect.fnUntraced(function* ({
    runtime,
    providerThreadId,
    runOrdinal,
  }: Terminal) {
    yield* Effect.sync(() => {
      const active = leases.get(runtime);
      const turnKey = key(providerThreadId, runOrdinal);
      active?.get(turnKey)?.close();
      active?.delete(turnKey);
    });
  });

  const stopped = Effect.fnUntraced(function* (runtime: Runtime) {
    yield* Effect.sync(() => {
      bindings.closeSession(runtime);
      leases.delete(runtime);
    });
  });

  const bind = Effect.fn("NativeImageExecution.bind")(function* (itemId: string, rpc: Rpc) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.capabilities.has("orchestration") || user === null || uid === undefined) {
      return yield* new NativeImageExecutionRefused({});
    }
    return yield* Effect.try({
      try: () => bindings.bind(scope, { platform, user, hostname, uid, origin }, itemId, rpc),
      catch: () => new NativeImageExecutionRefused({}),
    });
  });

  return NativeImageExecution.of({ started, terminal, stopped, bind });
});

export const layer = Layer.effect(NativeImageExecution, make);
