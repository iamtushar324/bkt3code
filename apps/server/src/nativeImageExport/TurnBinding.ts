/** T3-CUSTOM(expbkt3): Internal native-image authority. No tool, process or runtime registration. */

type RecordValue = Record<string, unknown>;

export interface NativeImageTurn {
  readonly threadId: string;
  readonly runId: string;
  readonly providerInstanceId: string;
  readonly credentialId: string;
  readonly runtimeSessionId: string;
  readonly runtimeIdentity: object;
}

type ActiveNativeImageTurn = NativeImageTurn & { readonly revocation: AbortController };

export interface NativeImageCaller {
  readonly principal: string;
  readonly backgroundGrantHash?: string | undefined;
  readonly thread?:
    | {
        readonly threadId: string;
        readonly providerInstanceId: string;
        readonly providerSessionId: string;
      }
    | undefined;
}

export interface NativeImageHost {
  readonly platform: string;
  readonly user: string;
  readonly hostname: string;
  readonly uid: number;
  readonly origin: string;
}

type Rpc = (tool: string, input: RecordValue) => Promise<unknown>;

const SOURCE_TOOL = "t3_ui_orchestration_get_turn_item";
const ASSET_TOOL = "t3_ui_assets_create_url";
const SOURCE_METHOD = "orchestration.getTurnItem";
const ASSET_METHOD = "assets.createUrl";
const ITEM = /^turn-item:provider:codex:native-item:call_[0-9a-f]{16,64}$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const ORIGIN = "http://127.0.0.1:13773";

export class NativeImageBindingRefused extends Error {
  constructor() {
    super("The native image execution binding is unavailable or no longer current.");
    this.name = "NativeImageBindingRefused";
  }
}

function refuse(): never {
  throw new NativeImageBindingRefused();
}

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : refuse();

const hasKeys = (value: RecordValue, keys: ReadonlyArray<string>) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * The provider-turn lifecycle supplies these values; no RPC request may open a turn.
 * Capture the actual startTurn.runId, not a latest-run query or a background-session liveness check.
 */
export class NativeImageTurnBindings {
  readonly #active = new Map<string, ActiveNativeImageTurn>();

  open(turn: NativeImageTurn) {
    if (
      !UUID.test(turn.threadId) ||
      !turn.runId.startsWith(`run:thread:${turn.threadId}:`) ||
      turn.providerInstanceId !== "codex" ||
      turn.credentialId.length === 0 ||
      turn.runtimeSessionId.length === 0
    ) {
      refuse();
    }
    const current = Object.freeze({ ...turn, revocation: new AbortController() });
    const previous = this.#active.get(turn.threadId);
    this.#active.set(turn.threadId, current);
    previous?.revocation.abort();
    // An old terminal callback must not revoke a replacement turn.
    return Object.freeze({
      close: () => {
        if (this.#active.get(turn.threadId) === current) this.#active.delete(turn.threadId);
        current.revocation.abort();
      },
    });
  }

  closeSession(runtimeIdentity: object) {
    for (const [threadId, turn] of Array.from(this.#active)) {
      if (turn.runtimeIdentity === runtimeIdentity) {
        if (this.#active.get(threadId) === turn) this.#active.delete(threadId);
        turn.revocation.abort();
      }
    }
  }

  bind(caller: NativeImageCaller, host: NativeImageHost, itemId: string, rpc: Rpc) {
    const thread = caller.thread;
    if (
      caller.principal !== "provider-session" ||
      caller.backgroundGrantHash !== undefined ||
      thread === undefined ||
      !ITEM.test(itemId) ||
      host.platform !== "darwin" ||
      host.user !== "beknown" ||
      host.hostname.length === 0 ||
      !Number.isSafeInteger(host.uid) ||
      host.uid < 0 ||
      host.origin !== ORIGIN
    ) {
      refuse();
    }
    const turn = this.#active.get(thread.threadId);
    if (
      turn === undefined ||
      turn.credentialId !== thread.providerSessionId ||
      turn.providerInstanceId !== thread.providerInstanceId
    ) {
      refuse();
    }
    const assertCurrent = () => {
      if (this.#active.get(turn.threadId) !== turn) refuse();
    };
    // Only code-owned dependencies reach this factory. Host and caller must never come from tool input.
    return new NativeImageBoundPort(turn, Object.freeze({ ...host }), itemId, rpc, assertCurrent);
  }
}

class NativeImageBoundPort {
  #sourceVerified = false;
  #mintAttempted = false;
  #busy = false;
  readonly #turn: ActiveNativeImageTurn;
  readonly #host: NativeImageHost;
  readonly #itemId: string;
  readonly #rpc: Rpc;
  readonly #assertCurrent: () => void;

  constructor(
    turn: ActiveNativeImageTurn,
    host: NativeImageHost,
    itemId: string,
    rpc: Rpc,
    assertCurrent: () => void,
  ) {
    this.#turn = turn;
    this.#host = host;
    this.#itemId = itemId;
    this.#rpc = rpc;
    this.#assertCurrent = assertCurrent;
  }

  toJSON(): never {
    return refuse();
  }

  get signal(): AbortSignal {
    return this.#turn.revocation.signal;
  }

  execution() {
    this.#assertCurrent();
    return {
      thread_id: this.#turn.threadId,
      run_id: this.#turn.runId,
      host: this.#host.hostname,
      uid: this.#host.uid,
      origin: this.#host.origin,
    };
  }

  async call(tool: string, value: unknown) {
    if (this.#busy) refuse();
    this.#busy = true;
    try {
      return await this.#call(tool, value);
    } finally {
      this.#busy = false;
    }
  }

  async #call(tool: string, value: unknown) {
    this.#assertCurrent();
    const input = record(value);
    const source = tool === SOURCE_TOOL;
    let request: RecordValue;
    if (source) {
      if (
        !hasKeys(input, ["threadId", "itemId"]) ||
        input.threadId !== this.#turn.threadId ||
        input.itemId !== this.#itemId
      ) {
        refuse();
      }
      this.#sourceVerified = false;
      request = { threadId: this.#turn.threadId, itemId: this.#itemId };
    } else if (tool === ASSET_TOOL) {
      const resource = record(input.resource);
      if (
        !this.#sourceVerified ||
        this.#mintAttempted ||
        !hasKeys(input, ["resource"]) ||
        !hasKeys(resource, ["_tag", "threadId", "itemId", "index"]) ||
        resource._tag !== "tool-output-image" ||
        resource.threadId !== this.#turn.threadId ||
        resource.itemId !== this.#itemId ||
        resource.index !== 0
      ) {
        refuse();
      }
      // Dispatch uncertainty must never cause a second asset mint through this port.
      this.#mintAttempted = true;
      request = {
        resource: {
          _tag: "tool-output-image",
          threadId: this.#turn.threadId,
          itemId: this.#itemId,
          index: 0,
        },
      };
    } else {
      refuse();
    }

    let result: RecordValue;
    try {
      result = record(await this.#rpc(tool, request));
    } catch {
      // RPC exceptions can contain bearer asset paths. Neither retain nor chain them.
      return refuse();
    }
    this.#assertCurrent();
    if (
      result.ok !== true ||
      result.index !== 0 ||
      result.stream !== false ||
      result.tool !== tool ||
      result.method !== (source ? SOURCE_METHOD : ASSET_METHOD)
    ) {
      refuse();
    }
    const body = record(result.result);
    if (source) {
      const item = record(body.item);
      const native = record(item.nativeItemRef);
      const sourceRef = record(item.toolSource);
      const nativeId = this.#itemId.slice("turn-item:provider:codex:native-item:".length);
      if (
        item.id !== this.#itemId ||
        item.threadId !== this.#turn.threadId ||
        item.runId !== this.#turn.runId ||
        item.status !== "completed" ||
        item.streaming === true ||
        item.type !== "dynamic_tool" ||
        item.toolName !== "cua_repl.js" ||
        item.toolSurface !== "computer" ||
        item.nodeId !== `node:provider:codex:native-item:${nativeId}` ||
        native.driver !== "codex" ||
        native.strength !== "strong" ||
        native.nativeId !== nativeId ||
        sourceRef.key !== "native-app:com.google.chrome" ||
        sourceRef.kind !== "computer"
      ) {
        refuse();
      }
      this.#sourceVerified = true;
    }
    return result;
  }
}
