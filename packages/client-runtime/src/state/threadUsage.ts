/**
 * T3-CUSTOM(expbkt3): client atoms for one thread's API-level cost.
 *
 * A keyed query, not a subscription: the figure changes only when a turn
 * lands, and the caller refetches on that cadence. Sixty seconds of staleness
 * keeps a header pill from rescanning transcripts on every re-render.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export function createThreadUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  return {
    usage: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-usage:get",
      tag: WS_METHODS.threadUsageGet,
      staleTimeMs: 60_000,
    }),
  };
}
