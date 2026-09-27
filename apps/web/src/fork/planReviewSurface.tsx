/**
 * T3-CUSTOM(expbkt3): single entry point for the native plan review surface.
 *
 * Everything upstream files need lives here, so `ChatView`, `RightPanelTabs`
 * and `ProposedPlanCard` each take one import and one line rather than growing
 * plan-review logic inline. That keeps the next upstream merge cheap.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { lazy, useEffect, useRef } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { planReviewEnvironment } from "../state/planReview";
import { useEnvironmentQuery } from "../state/query";

/** Plate is ~200 kB gzip — it must only load when a review is actually opened. */
export const PlanReviewPanel = lazy(() => import("../components/planreview/PlanReviewPanel"));

export function resolveOpenPlanReviewDocumentId(
  documents: ReadonlyArray<{ readonly documentId: string; readonly status: string }> | undefined,
  activePlanId: string | null,
): string | null {
  if (activePlanId === null) return null;
  return documents?.find((document) => document.status === "open")?.documentId ?? null;
}

/**
 * The thread's reviewable plan, or null when there is none.
 *
 * At most one plan document per thread is `open` at a time: an agent revision
 * appends a version to the existing lineage rather than starting a new one, so
 * this resolves to a single id without ambiguity.
 */
export function useOpenPlanReviewDocumentId(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
  activePlanId: string | null = null,
): string | null {
  const enabled = useClientSettings((settings) => settings.nativePlanReviewEnabled);
  const { data, refresh } = useEnvironmentQuery(
    !enabled || environmentId === null || threadId === null
      ? null
      : planReviewEnvironment.list({ environmentId, input: { threadId } }),
  );
  const refreshedPlanKeyRef = useRef<string | null>(null);

  // The thread can be open before its proposed plan arrives. Refresh when that
  // plan first becomes actionable so listForThread can capture it immediately;
  // otherwise the empty query result remains cached until a page reload.
  useEffect(() => {
    if (!enabled || environmentId === null || threadId === null || activePlanId === null) return;
    const planKey = `${environmentId}:${threadId}:${activePlanId}`;
    if (refreshedPlanKeyRef.current === planKey) return;
    refreshedPlanKeyRef.current = planKey;
    refresh();
  }, [activePlanId, enabled, environmentId, refresh, threadId]);

  return resolveOpenPlanReviewDocumentId(data?.documents, activePlanId);
}
