import { expect, it } from "@effect/vitest";

import { serveNativeImagePipe } from "./NativeImagePipe.ts";
import { NativeImageRpc, NativeImageRpcClosed } from "./NativeImageRpc.ts";
import { NativeImageTurnBindings } from "./TurnBinding.ts";

const request = new TextEncoder().encode(
  JSON.stringify({ schema: "fiverr-native-rpc-ipc.v1", id: 1, method: "execution" }) + "\n",
);

function fixture(chunks: Uint8Array[], readError?: Error, dispatch?: () => Promise<unknown>) {
  const thread = "6825b7cc-4b34-48c0-9713-42b95cb866c3";
  const bindings = new NativeImageTurnBindings();
  const lease = bindings.open({
    threadId: thread,
    runId: `run:thread:${thread}:ordinal:1`,
    providerInstanceId: "codex",
    credentialId: "credential",
    runtimeSessionId: "runtime",
    runtimeIdentity: {},
  });
  const port = bindings.bind(
    {
      principal: "provider-session",
      thread: { threadId: thread, providerInstanceId: "codex", providerSessionId: "credential" },
    },
    {
      platform: "darwin",
      user: "beknown",
      hostname: "synthetic-usm",
      uid: 501,
      origin: "http://127.0.0.1:13773",
    },
    "turn-item:provider:codex:native-item:call_0123456789abcdef",
    dispatch ??
      (async () => {
        throw new Error("No RPC expected");
      }),
  );
  const output: string[] = [];
  let destroyed = false;
  const pipe = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
      if (readError) throw readError;
    },
    write(value: string, done: (error?: Error | null) => void) {
      output.push(value);
      done();
    },
    destroy() {
      destroyed = true;
    },
  };
  return { pipe, rpc: new NativeImageRpc(port), output, destroyed: () => destroyed, lease };
}

it("closes an idle private pipe immediately when its turn is revoked", async () => {
  const f = fixture([]);
  const reading = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
  let destroys = 0;
  const pipe = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          reading.resolve();
          return pending.promise;
        },
      };
    },
    write() {
      throw new Error("No response is expected on an idle revoked pipe");
    },
    destroy() {
      destroys++;
      pending.resolve({ done: true, value: undefined });
    },
  };
  const serving = serveNativeImagePipe(pipe, f.rpc);
  await reading.promise;
  f.lease.close();
  expect(destroys).toBe(1);
  expect(f.rpc.closed).toBe(true);
  await expect(serving).rejects.toThrow(NativeImageRpcClosed);
  expect(destroys).toBe(1);
});

it("handles fragmented request frames on the private channel", async () => {
  const f = fixture([request.subarray(0, 11), request.subarray(11)]);
  await serveNativeImagePipe(f.pipe, f.rpc);
  expect(JSON.parse(f.output[0]!).ok).toBe(true);
  expect(f.output).toHaveLength(1);
  expect(f.destroyed()).toBe(true);
  expect(f.rpc.closed).toBe(true);
});

it.each([
  { chunks: [new Uint8Array(16 * 1024 + 2)] },
  { chunks: [new Uint8Array([255, 10])] },
  { chunks: [request.subarray(0, 5)] },
  { chunks: [new Uint8Array([...request, ...request])] },
])(
  "closes oversized, invalid, partial or pipelined frames before dispatch %j",
  async ({ chunks }) => {
    const f = fixture(chunks);
    await expect(serveNativeImagePipe(f.pipe, f.rpc)).rejects.toThrow(NativeImageRpcClosed);
    expect(f.output).toEqual([]);
    expect(f.destroyed()).toBe(true);
  },
);

it("does not expose the original stream error", async () => {
  const secret = "synthetic-private-pipe-secret";
  const f = fixture([], new Error(secret));
  const error = await serveNativeImagePipe(f.pipe, f.rpc).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeImageRpcClosed);
  expect((error as Error).stack).not.toContain(secret);
  expect((error as Error).cause).toBeUndefined();
});

it("does not start reading an already revoked pipe", async () => {
  const f = fixture([]);
  let reads = 0;
  f.lease.close();
  await expect(
    serveNativeImagePipe(
      {
        ...f.pipe,
        [Symbol.asyncIterator]() {
          reads++;
          throw new Error("A revoked pipe must not be read");
        },
      },
      f.rpc,
    ),
  ).rejects.toThrow(NativeImageRpcClosed);
  expect(reads).toBe(0);
  expect(f.destroyed()).toBe(true);
  expect(f.output).toEqual([]);
});

it("destroys the channel before an in-flight private result settles and discards that result", async () => {
  const called = Promise.withResolvers<void>();
  const result = Promise.withResolvers<unknown>();
  const secret = "synthetic-private-asset-path";
  const frame = new TextEncoder().encode(
    JSON.stringify({
      schema: "fiverr-native-rpc-ipc.v1",
      id: 1,
      method: "call",
      tool: "t3_ui_orchestration_get_turn_item",
      input: {
        threadId: "6825b7cc-4b34-48c0-9713-42b95cb866c3",
        itemId: "turn-item:provider:codex:native-item:call_0123456789abcdef",
      },
    }) + "\n",
  );
  const f = fixture([frame], undefined, async () => {
    called.resolve();
    return result.promise;
  });
  const serving = serveNativeImagePipe(f.pipe, f.rpc);
  await called.promise;
  f.lease.close();
  expect(f.destroyed()).toBe(true);
  expect(f.rpc.closed).toBe(true);
  result.resolve({ relativeUrl: secret });
  const error = await serving.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeImageRpcClosed);
  expect((error as Error).stack).not.toContain(secret);
  expect(f.output).toEqual([]);
});

it("does not expose the original destroy failure", async () => {
  const f = fixture([]);
  const secret = "synthetic-destroy-failure";
  const error = await serveNativeImagePipe(
    {
      ...f.pipe,
      destroy() {
        throw new Error(secret);
      },
    },
    f.rpc,
  ).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeImageRpcClosed);
  expect((error as Error).stack).not.toContain(secret);
  expect((error as Error).cause).toBeUndefined();
});

it("does not write a valid response when revocation runs before the pipe continuation", async () => {
  const f = fixture([request]);
  const original = f.rpc.request.bind(f.rpc);
  let completedWhileCurrent = false;
  f.rpc.request = (line) => {
    const pending = original(line);
    void pending.then(
      (response) => {
        completedWhileCurrent = JSON.parse(response).ok === true && !f.rpc.signal.aborted;
        f.lease.close();
      },
      () => undefined,
    );
    return pending;
  };
  await expect(serveNativeImagePipe(f.pipe, f.rpc)).rejects.toThrow(NativeImageRpcClosed);
  expect(completedWhileCurrent).toBe(true);
  expect(f.output).toEqual([]);
  expect(f.destroyed()).toBe(true);
});

it("settles a pending write callback when revocation destroys the pipe", async () => {
  const f = fixture([request]);
  const writing = Promise.withResolvers<void>();
  let callback: ((error?: Error | null) => void) | undefined;
  let callbacks = 0;
  let destroys = 0;
  const secret = "synthetic-pending-write-error";
  const pipe = {
    ...f.pipe,
    write(_value: string, done: (error?: Error | null) => void) {
      callback = done;
      writing.resolve();
    },
    destroy() {
      destroys++;
      if (callback) {
        callbacks++;
        callback(new Error(secret));
        callback = undefined;
      }
    },
  };
  const serving = serveNativeImagePipe(pipe, f.rpc);
  await writing.promise;
  f.lease.close();
  const error = await serving.catch((value: unknown) => value);
  expect(error).toBeInstanceOf(NativeImageRpcClosed);
  expect((error as Error).stack).not.toContain(secret);
  expect((error as Error).cause).toBeUndefined();
  expect(callbacks).toBe(1);
  expect(destroys).toBe(1);
});
