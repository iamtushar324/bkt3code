// T3-CUSTOM(expbkt3): when the mobile plan-review surface is offered at all.
//
// Three independent gates, kept pure and separate from the screen so each can
// be tested and so "why is the CTA hidden?" is answerable:
//
//   1. The server must advertise the `planReview` capability. Upstream servers,
//      and fork servers from before plan review shipped, do not — calling
//      planReview.* against them fails the RPC rather than degrading.
//   2. The thread must have an actionable proposed plan, i.e. one the agent is
//      still waiting on. A plan already implemented is history.
//   3. A plan-review document must exist and still be open. The server creates
//      one from every proposed plan, but a document that has been approved or
//      discarded is read-only.
import type { ExecutionEnvironmentCapabilities, PlanReviewDocument } from "@t3tools/contracts";

export function environmentSupportsPlanReview(
  capabilities: ExecutionEnvironmentCapabilities | undefined,
): boolean {
  return capabilities?.planReview === true;
}

/**
 * The open document for a thread, or null.
 *
 * At most one document per thread should be open — the server appends revisions
 * to the existing lineage rather than starting a new document — but this takes
 * the most recently updated regardless, which is the one the agent is waiting
 * on if that invariant ever slips.
 */
export function resolveOpenPlanReviewDocument(
  documents: ReadonlyArray<PlanReviewDocument> | null | undefined,
): PlanReviewDocument | null {
  if (documents == null) return null;
  let newest: PlanReviewDocument | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const document of documents) {
    if (document.status !== "open") continue;
    const parsed = Date.parse(document.updatedAt);
    const rank = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (newest === null || rank > newestMs) {
      newest = document;
      newestMs = rank;
    }
  }
  return newest;
}

/**
 * Whether the thread screen should offer the "Review plan" call to action.
 *
 * `hasActionableProposedPlan` is the same signal the thread's "Plan Ready"
 * status pill reads, so the CTA appears and disappears alongside it.
 */
export function shouldOfferPlanReview(input: {
  readonly capabilities: ExecutionEnvironmentCapabilities | undefined;
  readonly hasActionableProposedPlan: boolean;
  readonly documents: ReadonlyArray<PlanReviewDocument> | null | undefined;
}): boolean {
  if (!environmentSupportsPlanReview(input.capabilities)) return false;
  if (!input.hasActionableProposedPlan) return false;
  return resolveOpenPlanReviewDocument(input.documents) !== null;
}
