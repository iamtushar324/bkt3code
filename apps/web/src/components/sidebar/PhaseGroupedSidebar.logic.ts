// T3-CUSTOM(expbkt3): Web bindings for the phase-grouped session list.
//
// The pure logic moved to @t3tools/client-runtime/state/phase-sidebar so the
// mobile thread list can share it. It is re-exported here so every existing
// import in apps/web keeps working unchanged — including the 3000-line
// PhaseGroupedSidebar.tsx, which was not touched by the move.
//
// What stays behind: the helpers that emit Tailwind class names. Tailwind only
// finds literal class strings by scanning source under apps/web, so moving
// these would silently drop the styles from the build.
export * from "@t3tools/client-runtime/state/phase-sidebar";

import type { PhaseSidebarPhaseId } from "@t3tools/client-runtime/state/phase-sidebar";

import { cn } from "../../lib/utils";

/**
 * T3-CUSTOM(expbkt3): Static tone table for worktree codenames. Tailwind scans
 * source for literal class names, so these cannot be interpolated hues.
 */
export const PHASE_SIDEBAR_CHECKOUT_TONES: readonly string[] = [
  "text-rose-600 dark:text-rose-300/90",
  "text-orange-600 dark:text-orange-300/90",
  "text-amber-600 dark:text-amber-300/90",
  "text-lime-600 dark:text-lime-300/90",
  "text-emerald-600 dark:text-emerald-300/90",
  "text-teal-600 dark:text-teal-300/90",
  "text-cyan-600 dark:text-cyan-300/90",
  "text-sky-600 dark:text-sky-300/90",
  "text-indigo-600 dark:text-indigo-300/90",
  "text-violet-600 dark:text-violet-300/90",
  "text-fuchsia-600 dark:text-fuchsia-300/90",
  "text-pink-600 dark:text-pink-300/90",
];

export function phaseSidebarCheckoutToneClassName(toneIndex: number | null): string {
  if (toneIndex === null) return "";
  return PHASE_SIDEBAR_CHECKOUT_TONES[toneIndex % PHASE_SIDEBAR_CHECKOUT_TONES.length] ?? "";
}

/**
 * Theme-aware lifecycle header surfaces. The hue is intentionally restrained:
 * headers should make the groups scannable without competing with urgent row
 * badges or the selected-thread treatment.
 */
export function phaseSidebarGroupHeaderClassName(phaseId: PhaseSidebarPhaseId): string {
  const tone = {
    needs_input:
      "border-red-500/20 bg-red-500/8 text-red-700 dark:border-red-400/20 dark:bg-red-400/8 dark:text-red-300",
    ask: "border-amber-500/20 bg-amber-500/8 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/8 dark:text-amber-300",
    plan_ready:
      "border-violet-500/20 bg-violet-500/9 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/9 dark:text-violet-300",
    ready:
      "border-emerald-500/16 bg-emerald-500/7 text-emerald-700 dark:border-emerald-400/16 dark:bg-emerald-400/7 dark:text-emerald-300",
    planning:
      "border-indigo-500/18 bg-indigo-500/8 text-indigo-700 dark:border-indigo-400/18 dark:bg-indigo-400/8 dark:text-indigo-300",
    implementing:
      "border-sky-500/18 bg-sky-500/8 text-sky-700 dark:border-sky-400/18 dark:bg-sky-400/8 dark:text-sky-300",
  } satisfies Record<PhaseSidebarPhaseId, string>;

  return cn(
    "mb-1.5 flex min-h-7 items-center gap-2 rounded-md border px-2 py-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.025)]",
    tone[phaseId],
  );
}

/**
 * T3-CUSTOM(expbkt3): header for any section. Lifecycle sections keep their
 * phase tone; project and custom sections are neutral, borrowing a phase tone
 * only while collapsed and hiding something urgent (the caller passes it).
 */
export function phaseSidebarSectionHeaderClassName(phaseId: PhaseSidebarPhaseId | null): string {
  if (phaseId !== null) return phaseSidebarGroupHeaderClassName(phaseId);
  return cn(
    "mb-1.5 flex min-h-7 items-center gap-2 rounded-md border px-2 py-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.025)]",
    "border-border/60 bg-muted/40 text-foreground/80",
  );
}

/**
 * Keep the routed thread visually distinct from multi-selected rows. The
 * persistent right-edge accent is rendered by PhaseThreadRow; these surfaces
 * provide enough contrast for the active row to remain obvious in both themes.
 */
export function phaseSidebarRowClassName(
  isActive: boolean,
  isSelected: boolean,
  needsUserInput: boolean,
  // T3-CUSTOM(expbkt3): a plan waiting on a human gets the Needs Input
  // treatment in violet — same geometry, different hue, so the two read as
  // siblings rather than as one urgent state.
  planReady = false,
  // T3-CUSTOM(expbkt3): an async question, in amber. It sits between the two:
  // someone asked, but the agent kept working, so it is not the red emergency.
  askPending = false,
): string {
  return cn(
    // T3-CUSTOM(expbkt3): Center the adaptive title/metadata content lane.
    "group/phase-row relative flex min-h-14 w-full cursor-pointer select-none items-center gap-2 rounded-md px-2 py-2 text-left outline-hidden transition-[background-color,color,box-shadow] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
    // T3-CUSTOM(expbkt3): Row surfaces carry routing state only. Priority is
    // read off the P0..P4 badge, so a prioritised row keeps the same background
    // as everything else and the routed row stays the one tinted surface in
    // the list — see phaseSidebarPriorityBadgeClassName.
    isActive && isSelected
      ? "bg-primary/26 text-foreground font-semibold ring-1 ring-inset ring-primary/55 hover:bg-primary/30 dark:bg-primary/32"
      : isSelected
        ? "bg-primary/18 text-foreground dark:bg-primary/26"
        : isActive
          ? "bg-primary/18 text-foreground font-semibold ring-1 ring-inset ring-primary/45 hover:bg-primary/22 dark:bg-primary/24"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
    // T3-CUSTOM(expbkt3): Flash only structured-question rows in the experimental sidebar.
    needsUserInput &&
      "animate-[pulse_1.25s_ease-in-out_infinite] bg-red-500/20 text-foreground ring-1 ring-inset ring-red-500/60 shadow-[inset_3px_0_0_0_var(--color-red-500),0_0_14px_rgba(239,68,68,0.22)] hover:bg-red-500/30 motion-reduce:animate-none",
    // T3-CUSTOM(expbkt3): the amber mirror, for a question asked mid-run. Only
    // a parked session outranks it.
    !needsUserInput &&
      askPending &&
      "animate-[pulse_1.25s_ease-in-out_infinite] bg-amber-500/20 text-foreground ring-1 ring-inset ring-amber-500/60 shadow-[inset_3px_0_0_0_var(--color-amber-500),0_0_14px_rgba(245,158,11,0.22)] hover:bg-amber-500/30 motion-reduce:animate-none",
    // T3-CUSTOM(expbkt3): the violet mirror, for a plan the human has to decide
    // on. A question always wins the row, so this never stacks with the red one.
    !needsUserInput &&
      !askPending &&
      planReady &&
      "animate-[pulse_1.25s_ease-in-out_infinite] bg-violet-500/20 text-foreground ring-1 ring-inset ring-violet-500/60 shadow-[inset_3px_0_0_0_var(--color-violet-500),0_0_14px_rgba(139,92,246,0.22)] hover:bg-violet-500/30 motion-reduce:animate-none",
  );
}

export function phaseSidebarRowActionsClassName(isSurfaceOpen: boolean): string {
  return cn(
    "absolute top-1/2 right-1 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border border-border/70 bg-background/95 p-0.5 shadow-sm backdrop-blur-sm group-hover/phase-row:flex group-focus-visible/phase-row:flex group-has-[:focus-visible]/phase-row:flex",
    isSurfaceOpen && "flex",
  );
}

/**
 * T3-CUSTOM(expbkt3): The badge is now the only place priority is expressed, so
 * it carries the whole scale on its own.
 *
 * P0 keeps the full Linear-attention orange. Each step down mixes ~20% more
 * neutral into it, landing on plain grey at P4. The mix runs in oklab against a
 * neutral of the same lightness, so the ladder reads as "less urgent" through
 * falling saturation while every rung keeps identical contrast against the black
 * label — dropping actual lightness instead would make P3/P4 unreadable in the
 * light theme.
 */
const PHASE_SIDEBAR_PRIORITY_BADGE_CLASS_NAMES = [
  "bg-orange-500 text-black shadow-sm",
  "bg-[color-mix(in_oklab,var(--color-orange-500)_80%,var(--color-neutral-400))] text-black shadow-sm",
  "bg-[color-mix(in_oklab,var(--color-orange-500)_60%,var(--color-neutral-400))] text-black shadow-sm",
  "bg-[color-mix(in_oklab,var(--color-orange-500)_40%,var(--color-neutral-400))] text-black shadow-sm",
  "bg-neutral-400 text-black shadow-sm",
] as const;

export function phaseSidebarPriorityBadgeClassName(priority: number): string {
  return (
    PHASE_SIDEBAR_PRIORITY_BADGE_CLASS_NAMES[priority] ??
    PHASE_SIDEBAR_PRIORITY_BADGE_CLASS_NAMES.at(-1)!
  );
}
