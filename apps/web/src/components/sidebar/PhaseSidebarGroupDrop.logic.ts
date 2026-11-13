// T3-CUSTOM(expbkt3): dragging a session onto a custom group section.
//
// In Custom mode a session row can be dragged with the mouse onto any custom
// group's section (its header or its rows) to file it there, and onto
// "Ungrouped" to take it out of its group. The write is the same
// thread.meta.update { customGroup } that "Move to group" sends.
import { isReservedThreadCustomGroup, normalizeThreadCustomGroup } from "@t3tools/contracts";

/** The drag payload type. Custom, so a text field (the search box) never accepts the drop. */
export const PHASE_SIDEBAR_ROW_DRAG_TYPE = "application/x-t3-phase-sidebar-session";

export interface PhaseSidebarRowDropSection {
  readonly kind: string;
  /** The section id: a custom group's comparison key, or "ungrouped". */
  readonly id: string;
  readonly isUngrouped: boolean;
  /** The group's label as the header shows it. */
  readonly label: string;
}

/**
 * What a drop of a session on `section` writes: `{ customGroup }` (null
 * removes the session from its group), or null when the drop is refused —
 * not a custom group section, or the session is already filed there.
 * `rowCustomGroup` is the session's own label.
 */
export function resolvePhaseSidebarRowDrop(
  rowCustomGroup: string | null | undefined,
  section: PhaseSidebarRowDropSection,
): { readonly customGroup: string | null } | null {
  if (section.kind !== "custom") return null;
  const current =
    rowCustomGroup === null || rowCustomGroup === undefined
      ? null
      : normalizeThreadCustomGroup(rowCustomGroup);
  if (section.isUngrouped) return current === null ? null : { customGroup: null };
  const label = section.label.trim();
  if (label.length === 0 || isReservedThreadCustomGroup(label)) return null;
  if (current === section.id || current === normalizeThreadCustomGroup(label)) return null;
  return { customGroup: label };
}

/**
 * Rows drag only where the main pointer is a mouse or trackpad, so on a phone
 * or tablet a long press keeps opening the row's menu.
 */
export function phaseSidebarSupportsMouseDrag(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)")?.matches === true;
}
