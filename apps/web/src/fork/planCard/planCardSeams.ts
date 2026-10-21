/**
 * T3-CUSTOM(expbkt3): the one-line seams upstream plan and citation code calls.
 */
import { stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { use, useEffect } from "react";

import type { MessagesTimelineRow } from "../../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";
import { PlanCardContext } from "./planCardContext";

/**
 * Stands in for upstream's collapsed preview, which renders only the plan's
 * first lines. The fork keeps the whole plan mounted and lets the card clip
 * it, so selection, comments and HTML parts behave the same folded or open.
 */
export function buildCollapsedProposedPlanPreviewMarkdown(
  planMarkdown: string,
  _options?: { maxLines?: number },
): string {
  return stripDisplayedPlanMarkdown(planMarkdown);
}

/** Opens a folded plan card when a citation or comment asks to show a quote in it. */
export function useExpandPlanForCitation(setExpanded: (expanded: boolean) => void) {
  const card = use(PlanCardContext);
  // A citation names a plan by its id, in the field that usually holds a message id.
  const planId: string | null = card?.plan.id ?? null;
  const targeted = card !== null && card.timeline.citationRequest?.citation.messageId === planId;
  useEffect(() => {
    if (targeted) setExpanded(true);
  }, [setExpanded, targeted]);
}

/** Whether a timeline entry or row is the source a citation names: a message or a plan. */
export function isCitationSource(
  item: TimelineEntry | MessagesTimelineRow,
  sourceId: string,
): boolean {
  return (
    (item.kind === "message" && item.message.id === sourceId) ||
    (item.kind === "proposed-plan" && item.proposedPlan.id === sourceId)
  );
}

/** Whether a citation may point at this entry: an assistant response or a plan. */
export function isCitableSource(item: TimelineEntry): boolean {
  return (
    (item.kind === "message" && item.message.role === "assistant") || item.kind === "proposed-plan"
  );
}
