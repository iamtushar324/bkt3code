import { describe, expect, it } from "@effect/vitest";

import { NativeImageBindingRefused, NativeImageTurnBindings } from "./TurnBinding.ts";

const THREAD = "6825b7cc-4b34-48c0-9713-42b95cb866c3";
const RUN = `run:thread:${THREAD}:ordinal:11`;
const NATIVE = "call_0123456789abcdef";
const ITEM = `turn-item:provider:codex:native-item:${NATIVE}`;
const SOURCE = "t3_ui_orchestration_get_turn_item";
const ASSET = "t3_ui_assets_create_url";

function fixture() {
  const bindings = new NativeImageTurnBindings();
  const turn = {
    threadId: THREAD,
    runId: RUN,
    credentialId: "credential-a",
    providerInstanceId: "codex",
    runtimeSessionId: "runtime-a",
    runtimeIdentity: {},
  };
  const caller = {
    principal: "provider-session",
    thread: {
      threadId: THREAD,
      providerInstanceId: "codex",
      providerSessionId: "credential-a",
    },
  };
  const host = {
    platform: "darwin",
    user: "beknown",
    hostname: "synthetic-usm",
    uid: 501,
    origin: "http://127.0.0.1:13773",
  };
  const sourceInput = { threadId: THREAD, itemId: ITEM };
  const assetInput = {
    resource: { _tag: "tool-output-image", threadId: THREAD, itemId: ITEM, index: 0 },
  };
  const item = {
    id: ITEM,
    threadId: THREAD,
    runId: RUN,
    status: "completed",
    type: "dynamic_tool",
    toolName: "cua_repl.js",
    toolSurface: "computer",
    nodeId: `node:provider:codex:native-item:${NATIVE}`,
    nativeItemRef: { driver: "codex", nativeId: NATIVE, strength: "strong" },
    toolSource: { key: "native-app:com.google.chrome", kind: "computer" },
  };
  const calls: string[] = [];
  const rpc = async (tool: string) => {
    calls.push(tool);
    return {
      ok: true,
      tool,
      method: tool === SOURCE ? "orchestration.getTurnItem" : "assets.createUrl",
      index: 0,
      stream: false,
      result: tool === SOURCE ? { item } : { relativeUrl: "/synthetic-secret" },
    };
  };
  const lease = bindings.open(turn);
  const port = bindings.bind(caller, host, ITEM, rpc);
  return { bindings, turn, caller, host, sourceInput, assetInput, item, calls, rpc, lease, port };
}

describe("native image turn binding", () => {
  it("uses the registered provider-turn identity and permits one pinned image", async () => {
    const f = fixture();
    expect(f.port.execution()).toEqual({
      thread_id: THREAD,
      run_id: RUN,
      host: f.host.hostname,
      uid: f.host.uid,
      origin: f.host.origin,
    });
    await f.port.call(SOURCE, f.sourceInput);
    await f.port.call(ASSET, f.assetInput);
    expect(f.calls).toEqual([SOURCE, ASSET]);
    await expect(f.port.call(ASSET, f.assetInput)).rejects.toThrow(NativeImageBindingRefused);
    expect(f.calls).toHaveLength(2);
  });

  it("does not accept a latest-run guess or an idle/background-only session", () => {
    const f = fixture();
    f.lease.close();
    expect(() => f.bindings.bind(f.caller, f.host, ITEM, f.rpc)).toThrow(NativeImageBindingRefused);
    expect(() => f.port.execution()).toThrow(NativeImageBindingRefused);
  });

  it("revokes an old port when the same credential starts another turn", () => {
    const f = fixture();
    f.bindings.open({ ...f.turn, runId: `run:thread:${THREAD}:ordinal:12` });
    expect(() => f.port.execution()).toThrow(NativeImageBindingRefused);
  });

  it("does not let an old terminal callback remove a replacement turn", () => {
    const f = fixture();
    const next = `run:thread:${THREAD}:ordinal:12`;
    f.bindings.open({ ...f.turn, runId: next });
    f.lease.close();
    expect(f.bindings.bind(f.caller, f.host, ITEM, f.rpc).execution().run_id).toBe(next);
  });

  it("revokes all ports belonging to a stopped runtime", () => {
    const f = fixture();
    f.bindings.closeSession(f.turn.runtimeIdentity);
    expect(() => f.port.execution()).toThrow(NativeImageBindingRefused);
  });

  it("does not revoke a replacement process that reused the logical runtime id", () => {
    const f = fixture();
    f.bindings.open({ ...f.turn, runtimeIdentity: {} });
    f.bindings.closeSession(f.turn.runtimeIdentity);
    expect(f.bindings.bind(f.caller, f.host, ITEM, f.rpc).execution().run_id).toBe(RUN);
  });

  it.each(["external-user", "external-operator"])("refuses the %s principal", (principal) => {
    const f = fixture();
    expect(() => f.bindings.bind({ ...f.caller, principal }, f.host, ITEM, f.rpc)).toThrow(
      NativeImageBindingRefused,
    );
  });

  it("refuses background grants and a replaced MCP credential", () => {
    const f = fixture();
    expect(() =>
      f.bindings.bind({ ...f.caller, backgroundGrantHash: "grant" }, f.host, ITEM, f.rpc),
    ).toThrow(NativeImageBindingRefused);
    expect(() =>
      f.bindings.bind(
        { ...f.caller, thread: { ...f.caller.thread, providerSessionId: "credential-b" } },
        f.host,
        ITEM,
        f.rpc,
      ),
    ).toThrow(NativeImageBindingRefused);
  });

  it.each([
    { platform: "linux" },
    { user: "someone-else" },
    { origin: "https://homebkt3.dev.beknown.live" },
    { origin: "http://127.0.0.1:13774" },
    { uid: -1 },
  ])("refuses an unqualified host %j", (delta) => {
    const f = fixture();
    expect(() => f.bindings.bind(f.caller, { ...f.host, ...delta }, ITEM, f.rpc)).toThrow(
      NativeImageBindingRefused,
    );
  });

  it("refuses arbitrary operations, extra fields, other items and mint-before-read", async () => {
    const f = fixture();
    await expect(f.port.call("t3_ui_projects_read_file", {})).rejects.toThrow(
      NativeImageBindingRefused,
    );
    await expect(f.port.call(SOURCE, { ...f.sourceInput, extra: true })).rejects.toThrow(
      NativeImageBindingRefused,
    );
    await expect(f.port.call(SOURCE, { ...f.sourceInput, threadId: "other" })).rejects.toThrow(
      NativeImageBindingRefused,
    );
    await expect(f.port.call(ASSET, f.assetInput)).rejects.toThrow(NativeImageBindingRefused);
    expect(f.calls).toEqual([]);
  });

  it.each([
    { runId: "old-run" },
    { status: "running" },
    { status: "completed", streaming: true },
    { toolName: "terminal" },
    { toolSource: { kind: "computer", key: "native-app:other" } },
    { nativeItemRef: { driver: "codex", nativeId: NATIVE, strength: "weak" } },
  ])("rejects a wrong or incomplete native source %j", async (delta) => {
    const f = fixture();
    Object.assign(f.item, delta);
    await expect(f.port.call(SOURCE, f.sourceInput)).rejects.toThrow(NativeImageBindingRefused);
    await expect(f.port.call(ASSET, f.assetInput)).rejects.toThrow(NativeImageBindingRefused);
    expect(f.calls).toEqual([SOURCE]);
  });

  it("refuses concurrent RPC calls and a result that arrives after the turn ends", async () => {
    const f = fixture();
    let resolve: (value: unknown) => void = () => {};
    const result = new Promise<unknown>((done) => {
      resolve = done;
    });
    const port = f.bindings.bind(f.caller, f.host, ITEM, async () => result);
    const pending = port.call(SOURCE, f.sourceInput);
    await expect(port.call(SOURCE, f.sourceInput)).rejects.toThrow(NativeImageBindingRefused);
    f.lease.close();
    resolve(await f.rpc(SOURCE));
    await expect(pending).rejects.toThrow(NativeImageBindingRefused);
  });

  it("does not remint after an uncertain dispatch or expose the original exception", async () => {
    const f = fixture();
    const secret = "signed-secret-path-must-not-escape";
    const calls: string[] = [];
    const port = f.bindings.bind(f.caller, f.host, ITEM, async (tool) => {
      calls.push(tool);
      if (tool === ASSET) throw new Error(secret);
      return f.rpc(tool);
    });
    await port.call(SOURCE, f.sourceInput);
    const error = await port.call(ASSET, f.assetInput).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(NativeImageBindingRefused);
    expect(String(error)).not.toContain(secret);
    expect((error as Error).stack).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();
    await expect(port.call(ASSET, f.assetInput)).rejects.toThrow(NativeImageBindingRefused);
    expect(calls).toEqual([SOURCE, ASSET]);
  });

  it("cannot serialize a port or expose its internal RPC dispatcher", () => {
    const f = fixture();
    expect(() => JSON.stringify(f.port)).toThrow(NativeImageBindingRefused);
    expect(Object.keys(f.port)).toEqual([]);
  });
});
