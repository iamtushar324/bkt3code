/**
 * T3-CUSTOM(expbkt3): the seam upstream's `AssistantSelectionToolbar` exposes
 * to fork actions. Kept in its own module so the toolbar imports one type.
 */
import type { AssistantCitation, ScopedThreadRef } from "@t3tools/contracts";
import type { ComponentType } from "react";

import type { AssistantCitationSourceAnchor } from "../../lib/assistantTextSelection";

export interface AssistantSelectionToolbarExtrasProps {
  readonly citation: AssistantCitation;
  readonly sourceAnchor: AssistantCitationSourceAnchor;
  readonly threadRef: ScopedThreadRef;
  /** Closes the toolbar and clears its captured selection. */
  readonly dismiss: () => void;
}

export type AssistantSelectionToolbarExtras = ComponentType<AssistantSelectionToolbarExtrasProps>;
