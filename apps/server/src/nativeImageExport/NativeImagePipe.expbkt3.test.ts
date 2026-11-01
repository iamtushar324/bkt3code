import { expect, it } from "@effect/vitest";

import { serveNativeImagePipe } from "./NativeImagePipe.ts";
import { NativeImageRpc, NativeImageRpcClosed } from "./NativeImageRpc.ts";
import { NativeImageTurnBindings } from "./TurnBinding.ts";

const request = new TextEncoder().encode(
  JSON.stringify({ schema: "fiverr-native-rpc-ipc.v1", id: 1, method: "execution" }) + "\n",
);

function fixture(chunks: Uint8Array[], readError?: Error) {
  const thread = "6825b7cc-4b34-48c0-9713-42b95cb866c3";
  const bindings = new NativeImageTurnBindings();
  bindings.open({
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
    async () => {
      throw new Error("No RPC expected");
    },
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
  return { pipe, rpc: new NativeImageRpc(port), output, destroyed: () => destroyed };
}

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
