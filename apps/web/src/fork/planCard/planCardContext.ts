/**
 * T3-CUSTOM(expbkt3): what a timeline plan card needs from its row.
 *
 * `PlanCardRow` provides it; the fork pieces rendered inside upstream's
 * `ProposedPlanCard` read it, so the card itself takes no new props.
 */
import type { LegendListRef } from "@legendapp/list/react";
import type { CodexArtifactTemplate } from "@t3tools/client-runtime/codex-artifact-templates";
import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { createContext, type RefObject } from "react";

import type { AssistantCitationTarget } from "../../components/chat/AssistantCitationSource";
import type { ExpandedImagePreview } from "../../components/chat/ExpandedImagePreview";
import type { ProposedPlan } from "../../types";

/** The chat timeline state a plan shares with assistant messages. */
export interface PlanCardTimeline {
  readonly threadRef: ScopedThreadRef | null;
  readonly citationRequest: AssistantCitationTarget | null;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly onRunShellCommand: ((command: string) => void) | undefined;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly onUseArtifactTemplate: (template: CodexArtifactTemplate) => void;
}

export interface PlanCardContextValue {
  readonly plan: ProposedPlan;
  /** The timeline row's key, which citation scrolling targets. */
  readonly itemKey: string;
  readonly timeline: PlanCardTimeline;
  /** Whether the reader can widen the card here, or it is already wide. */
  readonly canWiden: boolean;
}

export const PlanCardContext = createContext<PlanCardContextValue | null>(null);
