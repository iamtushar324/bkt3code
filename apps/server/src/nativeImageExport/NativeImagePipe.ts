/** T3-CUSTOM(expbkt3): Framework adapter for the worker's private inherited socket, never stdout. */
import { NativeImageRpcClosed, type NativeImageRpc } from "./NativeImageRpc.ts";

interface PrivatePipe extends AsyncIterable<Uint8Array> {
  write(value: string, callback: (error?: Error | null) => void): unknown;
  destroy(): unknown;
}

const MAX_FRAME = 16 * 1024 + 1;

export async function serveNativeImagePipe(pipe: PrivatePipe, rpc: NativeImageRpc): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let fragments: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of pipe) {
      size += chunk.byteLength;
      if (size > MAX_FRAME) throw new NativeImageRpcClosed();
      const newline = chunk.indexOf(10);
      // The worker must await the response before sending another frame.
      if (newline >= 0 && newline !== chunk.byteLength - 1) throw new NativeImageRpcClosed();
      fragments.push(chunk);
      if (newline < 0) continue;
      const frame = new Uint8Array(size - 1);
      let offset = 0;
      for (const fragment of fragments) {
        const part = fragment === chunk ? fragment.subarray(0, fragment.byteLength - 1) : fragment;
        frame.set(part, offset);
        offset += part.byteLength;
      }
      const response = await rpc.request(decoder.decode(frame));
      await new Promise<void>((resolve, reject) => {
        pipe.write(response, (error) => (error ? reject(new NativeImageRpcClosed()) : resolve()));
      });
      fragments = [];
      size = 0;
      if (rpc.closed) break;
    }
    if (size !== 0) throw new NativeImageRpcClosed();
  } catch {
    // Neither pipe errors nor private response bytes may escape into an agent-visible error.
    throw new NativeImageRpcClosed();
  } finally {
    rpc.close();
    pipe.destroy();
  }
}
