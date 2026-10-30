import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
// T3-CUSTOM(expbkt3): 30 s, not 15 s. Production stalls of 3-14 s dropped live sockets, and each
// reconnect added load (TEC-1837). A closed or failed socket still ends the session at once.
export const PING_TIMEOUT = "30 seconds";
