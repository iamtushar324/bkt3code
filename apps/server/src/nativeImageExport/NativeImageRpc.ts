/** T3-CUSTOM(expbkt3): Private child-pipe protocol. Never an HTTP or MCP endpoint. */
import type { NativeImageTurnBindings } from "./TurnBinding.ts";

type Port = ReturnType<NativeImageTurnBindings["bind"]>;
const SCHEMA = "fiverr-native-rpc-ipc.v1";
const MAX_REQUEST = 16 * 1024;
const MAX_RESPONSE = 50 * 1024 * 1024;
const TOOLS = new Set(["t3_ui_orchestration_get_turn_item", "t3_ui_assets_create_url"]);

export class NativeImageRpcClosed extends Error {
  constructor() {
    super("The private native image channel is closed.");
    this.name = "NativeImageRpcClosed";
  }
}

/** Only the application-owned worker launcher may attach this object to its inherited pipe. */
export class NativeImageRpc {
  readonly #port: Port;
  #nextId = 1;
  #pending = false;
  #closed = false;
  readonly #onRevoke = () => this.close();

  constructor(port: Port) {
    this.#port = port;
    if (port.signal.aborted) this.close();
    else port.signal.addEventListener("abort", this.#onRevoke, { once: true });
  }

  close() {
    this.#closed = true;
    this.#port.signal.removeEventListener("abort", this.#onRevoke);
  }

  get closed() {
    return this.#closed;
  }

  get pending() {
    return this.#pending;
  }

  get signal(): AbortSignal {
    return this.#port.signal;
  }

  async request(line: string): Promise<string> {
    if (this.#closed || this.#pending) {
      this.close();
      throw new NativeImageRpcClosed();
    }
    this.#pending = true;
    let id = 0;
    try {
      if (new TextEncoder().encode(line).byteLength > MAX_REQUEST) throw new NativeImageRpcClosed();
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new NativeImageRpcClosed();
      }
      const request = value as Record<string, unknown>;
      if (request.schema !== SCHEMA || request.id !== this.#nextId)
        throw new NativeImageRpcClosed();
      id = this.#nextId++;
      let result: unknown;
      if (request.method === "execution" && Object.keys(request).length === 3) {
        result = this.#port.execution();
      } else if (
        request.method === "call" &&
        Object.keys(request).length === 5 &&
        typeof request.tool === "string" &&
        TOOLS.has(request.tool) &&
        Object.hasOwn(request, "input")
      ) {
        result = await this.#port.call(request.tool, request.input);
      } else {
        throw new NativeImageRpcClosed();
      }
      if (this.#closed) throw new NativeImageRpcClosed();
      const response = JSON.stringify({ schema: SCHEMA, id, ok: true, result });
      if (new TextEncoder().encode(response).byteLength > MAX_RESPONSE) {
        throw new NativeImageRpcClosed();
      }
      return response + "\n";
    } catch {
      this.close();
      return (
        JSON.stringify({ schema: SCHEMA, id, ok: false, error: "native_command_refused" }) + "\n"
      );
    } finally {
      this.#pending = false;
    }
  }
}
