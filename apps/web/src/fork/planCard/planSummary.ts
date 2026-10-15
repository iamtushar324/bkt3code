/**
 * T3-CUSTOM(expbkt3): the facts a plan card's header shows at a glance.
 */
import type { ProposedPlan } from "../../types";
import { isHtmlPlan, planHtmlTitle, splitPlanSegments } from "./planContent";

export interface PlanSummary {
  /** Top-level numbered items and task-list items outside code. */
  readonly steps: number;
  readonly readMinutes: number;
}

const WORDS_PER_MINUTE = 220;

export function summarizePlan(planMarkdown: string): PlanSummary {
  let steps = 0;
  let words = 0;
  for (const segment of splitPlanSegments(planMarkdown)) {
    if (segment.kind === "html") {
      const text = segment.html
        .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<[^>]+>/g, " ");
      words += text.split(/\s+/).filter(Boolean).length;
      continue;
    }
    let fenced = false;
    for (const line of segment.text.split(/\r?\n/)) {
      if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fenced = !fenced;
      if (fenced) continue;
      // Agents start top-level items at the margin; indented ones are details.
      if (/^(?:\d{1,3}[.)]|[-*+]\s+\[[ xX]\])\s+\S/.test(line)) steps += 1;
      words += line.split(/\s+/).filter((word) => /\w/.test(word)).length;
    }
  }
  return { steps, readMinutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)) };
}

/** The header title: the plan's first heading, else an HTML plan's own title. */
export function planCardTitle(planMarkdown: string, upstreamTitle: string): string {
  if (!isHtmlPlan(planMarkdown)) return upstreamTitle;
  return planHtmlTitle(planMarkdown) ?? upstreamTitle;
}

export const PLAN_STATUS_LABEL: Record<ProposedPlan["status"], string> = {
  draft: "Draft",
  active: "Ready",
  completed: "Done",
  superseded: "Superseded",
};

export const PLAN_STATUS_VARIANT = {
  draft: "outline",
  active: "info",
  completed: "success",
  superseded: "secondary",
} as const satisfies Record<ProposedPlan["status"], string>;
