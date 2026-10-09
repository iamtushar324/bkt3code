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
// T3-CUSTOM(expbkt3): Linear tags on a session.
import type { LinearIssueStatusSummary, ThreadLinearLink } from "@t3tools/contracts";
import { linearIssueFromBranch, parseLinearLinkUrl } from "@t3tools/shared/linearIssue";

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

/**
 * T3-CUSTOM(expbkt3): a session's Linear tags as the BK sidebar shows them.
 *
 * A session can carry a project, main issues and sub-issues. Stored tags win;
 * a thread with none falls back to the issue its `linear/ABC-123` branch names.
 * Whether an issue is a sub-issue is Linear's to say (its status summary names
 * a parent), so a tag reads as a main issue until its status arrives.
 */
export type PhaseSidebarLinearTagKind = "project" | "issue" | "sub-issue";

export interface PhaseSidebarLinearTagRef {
  readonly kind: ThreadLinearLink["kind"];
  readonly url: string;
  readonly identifier: string;
  readonly label: string;
  /** Stored on the thread, so it can be removed; false for the branch fallback. */
  readonly manual: boolean;
}

export interface PhaseSidebarLinearTagEntry {
  readonly kind: PhaseSidebarLinearTagKind;
  readonly url: string;
  /** Issue key, or the project name read from its slug. */
  readonly label: string;
  /** The status shown in the chip ("In Progress", "syncing…"); null for projects. */
  readonly statusText: string | null;
  readonly title: string | null;
  readonly tooltip: string;
  readonly manual: boolean;
}

export interface PhaseSidebarLinearTags {
  /** Display order: projects, main issues, sub-issues; tag order within each. */
  readonly entries: ReadonlyArray<PhaseSidebarLinearTagEntry>;
  /** The tag a single chip stands for: the first main issue, else the first tag. */
  readonly primary: PhaseSidebarLinearTagEntry;
  /** "ENG-1 (In Progress)", "Project name", or "ENG-1 +2" when there are several. */
  readonly label: string;
}

/** A thread's tags parsed once; rows memoise this on `linearLinks` + branch. */
export function phaseSidebarLinearTagRefs(
  branch: string | null | undefined,
  links: ReadonlyArray<ThreadLinearLink> | null | undefined,
): ReadonlyArray<PhaseSidebarLinearTagRef> {
  const refs: PhaseSidebarLinearTagRef[] = [];
  for (const link of links ?? []) {
    const parsed = parseLinearLinkUrl(link.url);
    if (!parsed || refs.some((ref) => ref.url === parsed.url)) continue;
    refs.push({ ...parsed, manual: true });
  }
  if (refs.length > 0) return refs;
  const fromBranch = linearIssueFromBranch(branch);
  return fromBranch
    ? [{ kind: "issue", ...fromBranch, label: fromBranch.identifier, manual: false }]
    : [];
}

/** Issue keys whose status the sidebar fetches, in one batched request per environment. */
export function phaseSidebarLinearIssueIdentifiers(
  refs: ReadonlyArray<PhaseSidebarLinearTagRef>,
): ReadonlyArray<string> {
  return refs.filter((ref) => ref.kind === "issue").map((ref) => ref.identifier);
}

/** Two status summaries that would render the same, so a refetch can keep the old object. */
export function samePhaseSidebarLinearIssueStatus(
  left: LinearIssueStatusSummary,
  right: LinearIssueStatusSummary,
): boolean {
  return (
    left.identifier === right.identifier &&
    left.url === right.url &&
    left.status === right.status &&
    left.statusType === right.statusType &&
    left.updatedAt === right.updatedAt &&
    left.error === right.error &&
    (left.title ?? null) === (right.title ?? null) &&
    (left.parentIdentifier ?? null) === (right.parentIdentifier ?? null)
  );
}

const PHASE_SIDEBAR_LINEAR_TAG_ORDER = {
  project: 0,
  issue: 1,
  "sub-issue": 2,
} satisfies Record<PhaseSidebarLinearTagKind, number>;

export function resolvePhaseSidebarLinearTags(
  refs: ReadonlyArray<PhaseSidebarLinearTagRef>,
  statuses: ReadonlyArray<LinearIssueStatusSummary>,
): PhaseSidebarLinearTags | null {
  const statusFor = (identifier: string) =>
    statuses.find((status) => status.identifier === identifier) ?? null;
  const entries = refs
    .map((ref): PhaseSidebarLinearTagEntry => {
      if (ref.kind === "project") {
        return {
          kind: "project",
          url: ref.url,
          label: ref.label,
          statusText: null,
          title: null,
          tooltip: `Project: ${ref.label}`,
          manual: ref.manual,
        };
      }
      const status = statusFor(ref.identifier);
      const parent = status?.parentIdentifier ?? null;
      const title = status?.title ?? null;
      return {
        kind: parent === null ? "issue" : "sub-issue",
        url: ref.url,
        label: ref.label,
        statusText: status?.status ?? (status?.error ? "unavailable" : "syncing…"),
        title,
        tooltip: `${ref.label} (${status?.status ?? status?.error ?? "syncing…"})${
          parent === null ? "" : ` · sub-issue of ${parent}`
        }${title === null ? "" : ` · ${title}`}`,
        manual: ref.manual,
      };
    })
    // toSorted is stable, so tag order survives within a kind.
    .toSorted(
      (left, right) =>
        PHASE_SIDEBAR_LINEAR_TAG_ORDER[left.kind] - PHASE_SIDEBAR_LINEAR_TAG_ORDER[right.kind],
    );
  const first = entries[0];
  if (!first) return null;
  const primary = entries.find((entry) => entry.kind === "issue") ?? first;
  const label =
    entries.length > 1
      ? `${primary.label} +${entries.length - 1}`
      : primary.statusText === null
        ? primary.label
        : `${primary.label} (${primary.statusText})`;
  return { entries, primary, label };
}

/** T3-CUSTOM(expbkt3): what one parked shelf (snoozed, settled) renders. */
export interface PhaseSidebarShelfRows<Row> {
  /** The rows on screen: none while the shelf is collapsed. */
  readonly rendered: ReadonlyArray<Row>;
  /** Rows an expanded shelf pages out behind "Show more"; 0 while collapsed. */
  readonly hiddenCount: number;
  /** The open thread is parked on this shelf, whether or not it is on screen. */
  readonly containsRoutedThread: boolean;
}

/**
 * T3-CUSTOM(expbkt3): a collapsed shelf renders no rows — not even the open
 * thread's, which used to be drawn inside it and made the shelf look open.
 * Its header says the open thread is in there instead. An expanded shelf
 * pages in `visibleCount` rows and adds the open thread when it is paged out,
 * so a thread reached by route still has its wake or un-settle action.
 */
export function resolvePhaseSidebarShelfRows<Row>(input: {
  readonly rows: ReadonlyArray<Row>;
  readonly collapsed: boolean;
  readonly keyOf: (row: Row) => string;
  readonly routedKey: string | null;
  /** How many rows an expanded shelf pages in; all of them when omitted. */
  readonly visibleCount?: number;
}): PhaseSidebarShelfRows<Row> {
  const { rows, keyOf, routedKey } = input;
  const routedIndex = routedKey === null ? -1 : rows.findIndex((row) => keyOf(row) === routedKey);
  const containsRoutedThread = routedIndex !== -1;
  if (input.collapsed) return { rendered: [], hiddenCount: 0, containsRoutedThread };
  const page = rows.slice(0, Math.max(0, input.visibleCount ?? rows.length));
  const routedRow = containsRoutedThread ? rows[routedIndex] : undefined;
  const rendered =
    routedRow !== undefined && routedIndex >= page.length ? [...page, routedRow] : page;
  return { rendered, hiddenCount: rows.length - rendered.length, containsRoutedThread };
}
