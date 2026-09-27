/**
 * T3-CUSTOM(expbkt3): client atoms for native plan review.
 *
 * Mutations are serialised per document rather than per environment: two people
 * reviewing different plans should not queue behind each other, but concurrent
 * writes to one document must stay ordered so the draft revision token means
 * something.
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";

export function createPlanReviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const serialByDocument = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly documentId: string };
    }) => `${environmentId}:${input.documentId}`,
  };

  return {
    review: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plan-review:get",
      tag: WS_METHODS.planReviewGet,
    }),
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plan-review:list",
      tag: WS_METHODS.planReviewList,
    }),
    versionDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:plan-review:version-diff",
      tag: WS_METHODS.planReviewVersionDiff,
    }),
    subscription: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:plan-review:subscribe",
      tag: WS_METHODS.subscribePlanReview,
      idleTtlMs: 5_000,
    }),
    saveDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plan-review:save-draft",
      tag: WS_METHODS.planReviewSaveDraft,
      scheduler,
      concurrency: serialByDocument,
    }),
    cutVersion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plan-review:cut-version",
      tag: WS_METHODS.planReviewCutVersion,
      scheduler,
      concurrency: serialByDocument,
    }),
    upsertDiscussion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plan-review:upsert-discussion",
      tag: WS_METHODS.planReviewUpsertDiscussion,
      scheduler,
      concurrency: serialByDocument,
    }),
    resolveDiscussion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plan-review:resolve-discussion",
      tag: WS_METHODS.planReviewResolveDiscussion,
      scheduler,
      concurrency: serialByDocument,
    }),
    submit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:plan-review:submit",
      tag: WS_METHODS.planReviewSubmit,
      scheduler,
      concurrency: serialByDocument,
    }),
  };
}
