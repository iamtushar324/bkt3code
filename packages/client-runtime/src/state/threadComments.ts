/**
 * T3-CUSTOM(expbkt3): client atoms for review comments on agent messages.
 *
 * Mutations are serialised per thread: every write returns the thread's fresh
 * snapshot, so two writes to one thread must stay ordered for the last result
 * to be the truth, while different threads never queue behind each other.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export function createThreadCommentsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialByThread = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly threadId: string };
    }) => `${environmentId}:${input.threadId}`,
  };

  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:thread-comments:list",
      tag: WS_METHODS.threadCommentsList,
    }),
    subscription: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:thread-comments:subscribe",
      tag: WS_METHODS.subscribeThreadComments,
      idleTtlMs: 5_000,
    }),
    add: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-comments:add",
      tag: WS_METHODS.threadCommentsAdd,
      scheduler,
      concurrency: serialByThread,
    }),
    reply: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-comments:reply",
      tag: WS_METHODS.threadCommentsReply,
      scheduler,
      concurrency: serialByThread,
    }),
    setStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-comments:set-status",
      tag: WS_METHODS.threadCommentsSetStatus,
      scheduler,
      concurrency: serialByThread,
    }),
    resolveAll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-comments:resolve-all",
      tag: WS_METHODS.threadCommentsResolveAll,
      scheduler,
      concurrency: serialByThread,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-comments:remove",
      tag: WS_METHODS.threadCommentsRemove,
      scheduler,
      concurrency: serialByThread,
    }),
    setDeliveryPaused: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:thread-comments:set-delivery-paused",
      tag: WS_METHODS.threadCommentsSetDeliveryPaused,
      scheduler,
      concurrency: serialByThread,
    }),
  };
}
