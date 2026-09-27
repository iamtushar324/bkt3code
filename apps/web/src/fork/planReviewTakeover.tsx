/**
 * T3-CUSTOM(expbkt3): a reviewable plan takes the transcript, not the composer.
 *
 * The team moved its blocking decisions from `AskUserQuestion` onto native plan
 * gates, which made a ready plan the quietest state in the app: a Preview button
 * on a card somewhere up the transcript. This mounts the review panel over the
 * message area the moment a plan becomes reviewable, so the decision is the
 * thing on screen.
 *
 * It covers the transcript and nothing else. `ChatView` mounts it as the last
 * child of the messages wrapper, which is already `relative` and already
 * excludes the input bar, so `absolute inset-0` leaves the chat header, the
 * composer, the sidebar and the right panel live — the same seam
 * `AgentUiExpandedSurface` uses. It cannot live inside the timeline row that
 * produced the plan: those rows are virtualized, so they clip and recycle out
 * from under an overlay.
 *
 * @module planReviewTakeover
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { memo, Suspense, useEffect } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { usePlanReviewTakeoverStore } from "../planReviewTakeoverStore";
import { PlanReviewPanel } from "./planReviewSurface";

/**
 * Whether the takeover is showing, derived rather than stored.
 *
 * `documentId` is null both before a plan exists and during the window where
 * the server is still capturing it, so "no plan" and "not captured yet" collapse
 * into the same answer: stay out of the way.
 */
export function shouldShowPlanReviewTakeover(input: {
  readonly enabled: boolean;
  readonly documentId: string | null;
  readonly dismissedDocumentIds: ReadonlyArray<string>;
}): boolean {
  if (!input.enabled || input.documentId === null) return false;
  return !input.dismissedDocumentIds.includes(input.documentId);
}

export const PlanReviewTakeover = memo(function PlanReviewTakeover({
  threadRef,
  documentId,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly documentId: string | null;
}) {
  const enabled = useClientSettings((settings) => settings.planReviewAutoOpenEnabled);
  const dismissedDocumentIds = usePlanReviewTakeoverStore((state) => state.dismissedDocumentIds);
  if (threadRef === null || documentId === null) return null;
  if (!shouldShowPlanReviewTakeover({ enabled, documentId, dismissedDocumentIds })) return null;
  return (
    // Keyed on the document so a new plan mounts a fresh panel rather than
    // reusing the previous one's editor state.
    <PlanReviewTakeoverContent key={documentId} threadRef={threadRef} documentId={documentId} />
  );
});

function PlanReviewTakeoverContent({
  threadRef,
  documentId,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly documentId: string;
}) {
  const dismiss = usePlanReviewTakeoverStore((state) => state.dismiss);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      dismiss(documentId);
    };
    // Capture phase: the composer and the timeline both handle Escape, and the
    // takeover is the frontmost surface, so it answers first.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dismiss, documentId]);

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-background"
      role="dialog"
      aria-label="Plan ready for your decision"
      data-plan-review-takeover
    >
      <button
        type="button"
        className="absolute top-2 right-2 z-50 flex size-8 items-center justify-center rounded-full border border-border/70 bg-background/90 text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Close the plan review"
        data-plan-review-takeover-close
        onClick={() => dismiss(documentId)}
      >
        <XIcon className="size-4" aria-hidden />
      </button>
      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <PlanReviewPanel
            environmentId={threadRef.environmentId}
            documentId={documentId}
            onClose={() => dismiss(documentId)}
            showConversationComposer
          />
        </Suspense>
      </div>
    </div>
  );
}
