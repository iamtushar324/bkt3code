// T3-CUSTOM(expbkt3): mobile's class strings for the phase sidebar.
//
// The web sidebar keeps its own equivalents under apps/web because Tailwind only
// scans source there. Mobile's uniwind scans apps/mobile, so the class strings
// have to appear literally in this file — which is why these are duplicated by
// design rather than shared. Everything that *decides* a tone is shared; only
// the literal class names live here.
import type { PhaseSidebarPhaseId } from "@t3tools/client-runtime/state/phase-sidebar";
import type { ChangeRequestStateLike } from "@t3tools/client-runtime/state/thread-settled";

/** Lifecycle header tint, matching the web sidebar's phase hues. */
export function phaseSidebarSectionToneClassName(phaseId: PhaseSidebarPhaseId): string {
  switch (phaseId) {
    case "needs_input":
      return "text-adaptive-amber-700-300";
    // T3-CUSTOM(expbkt3): an async question, amber like the web sidebar.
    case "ask":
      return "text-adaptive-amber-700-300";
    case "plan_ready":
      return "text-adaptive-violet-700-300";
    case "ready":
      return "text-adaptive-emerald-700-300";
    case "planning":
      return "text-adaptive-indigo-700-300";
    case "implementing":
      return "text-adaptive-sky-700-300";
  }
}

/**
 * Priority pill. P0 reads as urgent and desaturates as it descends, so a screen
 * full of P2s does not shout.
 */
export function phaseSidebarPriorityToneClassName(priority: number): string {
  if (priority <= 0) return "bg-orange-500 text-white";
  if (priority === 1) return "bg-amber-500 text-white";
  if (priority === 2) return "bg-amber-700/70 text-white";
  return "bg-subtle text-foreground-muted";
}

/**
 * PR state by colour alone, matching web: green open, violet merged, red closed.
 * State words stay out of the lane — it is already the densest text on screen.
 */
export function phaseSidebarChangeRequestToneClassName(state: ChangeRequestStateLike): string {
  switch (state) {
    case "merged":
      return "text-adaptive-violet-600-400";
    case "closed":
      return "text-adaptive-rose-600-400";
    default:
      return "text-adaptive-emerald-600-400";
  }
}

/** Worktree codename tint. Mirrors web's static tone table, same 12 hues. */
const CHECKOUT_TONES: readonly string[] = [
  "text-adaptive-rose-600-400/90",
  "text-adaptive-amber-700-300/90",
  "text-adaptive-amber-700-300/90",
  "text-adaptive-emerald-700-300/90",
  "text-adaptive-emerald-600-400/90",
  "text-adaptive-sky-700-300/90",
  "text-adaptive-sky-600-400/90",
  "text-adaptive-sky-600-400/90",
  "text-adaptive-indigo-600-300/90",
  "text-adaptive-violet-600-400/90",
  "text-adaptive-violet-600-400/90",
  "text-adaptive-rose-600-400/90",
];

export function phaseSidebarCheckoutToneClassName(toneIndex: number | null): string {
  if (toneIndex === null) return "text-foreground-muted";
  return CHECKOUT_TONES[toneIndex % CHECKOUT_TONES.length] ?? "text-foreground-muted";
}
