import { expect, it } from "@effect/vitest";

import { NativeImageRpc, NativeImageRpcClosed } from "./NativeImageRpc.ts";
import { NativeImageTurnBindings } from "./TurnBinding.ts";

const SCHEMA = "fiverr-native-rpc-ipc.v1";
const THREAD = "6825b7cc-4b34-48c0-9713-42b95cb866c3";
const ITEM = "turn-item:provider:codex:native-item:call_0123456789abcdef";

function fixture(
  rpc: (tool: string, input: Record<string, unknown>) => Promise<unknown> = async () => ({}),
) {
  const bindings = new NativeImageTurnBindings();
  const lease = bindings.open({
    threadId: THREAD,
    runId: `run:thread:${THREAD}:ordinal:1`,
    providerInstanceId: "codex",
    credentialId: "credential",
    runtimeSessionId: "runtime",
    runtimeIdentity: {},
  });
  const port = bindings.bind(
    {
      principal: "provider-session",
      thread: { threadId: THREAD, providerInstanceId: "codex", providerSessionId: "credential" },
    },
    {
      platform: "darwin",
      user: "beknown",
      hostname: "synthetic-usm",
      uid: 501,
      origin: "http://127.0.0.1:13773",
    },
    ITEM,
    rpc,
  );
  return { channel: new NativeImageRpc(port), lease };
}

it("transmits execution facts only from the bound application port", async () => {
  const f = fixture();
  const response = JSON.parse(
    await f.channel.request(JSON.stringify({ schema: SCHEMA, id: 1, method: "execution" })),
  );
  expect(response).toEqual({
    schema: SCHEMA,
    id: 1,
    ok: true,
    result: {
      thread_id: THREAD,
      run_id: `run:thread:${THREAD}:ordinal:1`,
      host: "synthetic-usm",
      uid: 501,
      origin: "http://127.0.0.1:13773",
    },
  });
});

it.each([
  { schema: "other", id: 1, method: "execution" },
  { schema: SCHEMA, id: 2, method: "execution" },
  { schema: SCHEMA, id: 1, method: "execution", thread_id: "caller-authored" },
  { schema: SCHEMA, id: 1, method: "call", tool: "arbitrary_write", input: {} },
])("closes malformed or unauthorized requests without dispatch %j", async (request) => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return {};
  });
  expect(JSON.parse(await f.channel.request(JSON.stringify(request))).ok).toBe(false);
  expect(calls).toBe(0);
  await expect(
    f.channel.request(JSON.stringify({ schema: SCHEMA, id: 1, method: "execution" })),
  ).rejects.toThrow(NativeImageRpcClosed);
});

it("refuses a replayed request id and does not dispatch it", async () => {
  const f = fixture();
  const request = JSON.stringify({ schema: SCHEMA, id: 1, method: "execution" });
  expect(JSON.parse(await f.channel.request(request)).ok).toBe(true);
  expect(JSON.parse(await f.channel.request(request)).ok).toBe(false);
});

it("caps incoming frames before JSON parsing", async () => {
  const f = fixture();
  expect(JSON.parse(await f.channel.request("x".repeat(16 * 1024 + 1))).ok).toBe(false);
});

it("suppresses the original private RPC exception and closes after failure", async () => {
  const secret = "synthetic-signed-bearer-path";
  const f = fixture(async () => {
    throw new Error(secret);
  });
  const response = await f.channel.request(
    JSON.stringify({
      schema: SCHEMA,
      id: 1,
      method: "call",
      tool: "t3_ui_orchestration_get_turn_item",
      input: { threadId: THREAD, itemId: ITEM },
    }),
  );
  expect(response).not.toContain(secret);
  expect(JSON.parse(response)).toEqual({
    schema: SCHEMA,
    id: 1,
    ok: false,
    error: "native_command_refused",
  });
});

it("returns no context after the real provider turn is closed", async () => {
  const f = fixture();
  f.lease.close();
  expect(
    JSON.parse(
      await f.channel.request(JSON.stringify({ schema: SCHEMA, id: 1, method: "execution" })),
    ).ok,
  ).toBe(false);
});
