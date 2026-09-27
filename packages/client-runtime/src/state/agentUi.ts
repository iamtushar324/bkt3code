/**
 * T3-CUSTOM(expbkt3): client atoms for agent-rendered UI surfaces.
 *
 * Renders are immutable, so this is a plain keyed query with no subscription:
 * once a box has its document it never changes, and an agent showing something
 * new produces a new render with its own key.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export function createAgentUiEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  return {
    render: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-ui:get-render",
      tag: WS_METHODS.agentUiGetRender,
    }),
  };
}
