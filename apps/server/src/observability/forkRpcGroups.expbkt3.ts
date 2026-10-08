// T3-CUSTOM(expbkt3): `rpc.aggregate` labels for the fork's WebSocket RPCs.
import { FORK_WS_RPCS } from "@t3tools/contracts";

type ForkWsRpcMethod = (typeof FORK_WS_RPCS)[number]["_tag"];

/**
 * The label is the method's namespace (`planReview.get` -> `planReview`); a stream RPC named
 * `subscribeX` is labelled by its subject (`subscribePlanReview` -> `planReview`). Derived from
 * `FORK_WS_RPCS`, so a new fork RPC is labelled without an edit here.
 */
export const forkRpcAggregate = (method: string): string => {
  if (method.startsWith("subscribe") && !method.includes(".")) {
    const subject = method.slice("subscribe".length);
    return subject.charAt(0).toLowerCase() + subject.slice(1);
  }
  return method.split(".")[0] ?? method;
};

export const FORK_RPC_AGGREGATES = Object.fromEntries(
  FORK_WS_RPCS.map((rpc) => [rpc._tag, forkRpcAggregate(rpc._tag)]),
) as Readonly<Record<ForkWsRpcMethod, string>>;
