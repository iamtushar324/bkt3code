// T3-CUSTOM(expbkt3): dedicated draft group without subscribing the whole sidebar to prompt edits.
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { ChevronDownIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";

import {
  useComposerDraftStore,
  type ComposerThreadDraftState,
  type DraftId,
} from "../../composerDraftStore";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import { cn } from "../../lib/utils";
import { usePhaseSidebarGroupingStore } from "../../phaseSidebarGroupingStore";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { useSidebar } from "../ui/sidebar";
import {
  phaseSidebarRowClassName,
  phaseSidebarSectionHeaderClassName,
} from "./PhaseGroupedSidebar.logic";
import {
  capturePhaseSidebarDraft,
  PHASE_SIDEBAR_DRAFTS_SECTION_KEY,
  phaseSidebarDraftPreview,
  selectPhaseSidebarDrafts,
  type PhaseSidebarDraftScope,
  type PhaseSidebarFrozenDraft,
} from "./PhaseSidebarDrafts.logic";

function useFrozenActiveDraft(routeDraftId: string | null): PhaseSidebarFrozenDraft {
  const [frozen, setFrozen] = useState<PhaseSidebarFrozenDraft>({ routeDraftId: null, row: null });
  if (frozen.routeDraftId !== routeDraftId) {
    // Like SidebarDraftBlock, capture synchronously on route change. A fresh active
    // composer stays absent until navigation away leaves an invested draft behind.
    setFrozen(capturePhaseSidebarDraft(useComposerDraftStore.getState(), routeDraftId));
  }
  return frozen;
}

/** Count-only parent subscription: typing never repaints the full session list. */
export function usePhaseSidebarDraftCount(scope: PhaseSidebarDraftScope): number {
  const frozen = useFrozenActiveDraft(scope.routeDraftId);
  return useComposerDraftStore((store) => selectPhaseSidebarDrafts(store, scope, frozen).length);
}

const PhaseSidebarDraftRow = memo(function PhaseSidebarDraftRow({
  draftId,
  composer,
  project,
  active,
  onNavigate,
  onDiscard,
}: {
  readonly draftId: DraftId;
  readonly composer: ComposerThreadDraftState;
  readonly project: ProjectFaviconProject | null;
  readonly active: boolean;
  readonly onNavigate: (draftId: DraftId) => void;
  readonly onDiscard: (draftId: DraftId) => void;
}) {
  const preview = phaseSidebarDraftPreview(composer);
  const accessibility = resolveSidebarRowAccessibility({
    title: preview,
    statusLabel: "Unsent draft",
    projectDisplayName: project?.title ?? null,
    isActive: active,
  });
  const navigate = useCallback(() => onNavigate(draftId), [onNavigate, draftId]);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onNavigate(draftId);
      }
    },
    [onNavigate, draftId],
  );
  const discard = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onDiscard(draftId);
    },
    [onDiscard, draftId],
  );
  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="phase-sidebar-draft-row"
        data-draft-id={draftId}
        className={cn(
          phaseSidebarRowClassName(active, false, false),
          !active && "bg-warning/4 hover:bg-warning/8",
        )}
        onClick={navigate}
        onKeyDown={onKeyDown}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <SquarePenIcon aria-hidden className="size-3 shrink-0 text-warning-foreground" />
            {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
            <span className="min-w-0 truncate text-xs text-secondary-label">{project?.title}</span>
          </div>
          <div aria-hidden className="mt-0.5 truncate text-sm font-medium text-foreground/90">
            {preview}
          </div>
        </div>
        <button
          type="button"
          aria-label="Discard draft"
          onClick={discard}
          className="shrink-0 cursor-pointer rounded-md px-1 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/phase-row:opacity-100"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </div>
    </li>
  );
});

export const PhaseSidebarDraftsGroup = memo(function PhaseSidebarDraftsGroup(
  scope: PhaseSidebarDraftScope,
) {
  const sessions = useComposerDraftStore((store) => store.draftThreadsByThreadKey);
  const composers = useComposerDraftStore((store) => store.draftsByThreadKey);
  const clearDraftThread = useComposerDraftStore((store) => store.clearDraftThread);
  const frozen = useFrozenActiveDraft(scope.routeDraftId);
  const drafts = useMemo(
    () =>
      selectPhaseSidebarDrafts(
        {
          draftThreadsByThreadKey: sessions,
          draftsByThreadKey: composers,
        },
        scope,
        frozen,
      ),
    [sessions, composers, scope, frozen],
  );
  const collapsed = usePhaseSidebarGroupingStore((store) =>
    store.grouping.collapsedSectionKeys.includes(PHASE_SIDEBAR_DRAFTS_SECTION_KEY),
  );
  const toggle = usePhaseSidebarGroupingStore((store) => store.toggleSectionCollapsed);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const navigate = useCallback(
    (draftId: DraftId) => {
      useThreadSelectionStore.getState().clearSelection();
      if (isMobile) setOpenMobile(false);
      void router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [isMobile, router, setOpenMobile],
  );
  const discard = useCallback(
    (draftId: DraftId) => {
      releaseComposerDraftUploads(draftId);
      clearDraftThread(draftId);
    },
    [clearDraftThread],
  );
  if (drafts.length === 0) return null;
  return (
    <section
      className="mb-3"
      data-testid="phase-sidebar-drafts"
      data-section-key={PHASE_SIDEBAR_DRAFTS_SECTION_KEY}
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-label={`Drafts, ${drafts.length} draft${drafts.length === 1 ? "" : "s"}${collapsed ? ", collapsed" : ""}`}
        onClick={() => toggle(PHASE_SIDEBAR_DRAFTS_SECTION_KEY)}
        className={cn(phaseSidebarSectionHeaderClassName(null), "w-full cursor-pointer text-left")}
        data-testid="phase-sidebar-drafts-toggle"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", collapsed && "-rotate-90")}
        />
        <span className="truncate text-[11px] font-bold uppercase tracking-[0.1em]">Drafts</span>
        <span className="h-px flex-1" />
        <span className="text-[9px] tabular-nums text-current/55">{drafts.length}</span>
      </button>
      {!collapsed ? (
        <ul className="space-y-0.5">
          {drafts.map((row) => (
            <PhaseSidebarDraftRow
              key={row.draftId}
              draftId={row.draftId}
              composer={row.composer}
              project={
                scope.projectByKey.get(
                  scopedProjectKey(
                    scopeProjectRef(row.session.environmentId, row.session.projectId),
                  ),
                ) ?? null
              }
              active={row.draftId === scope.routeDraftId}
              onNavigate={navigate}
              onDiscard={discard}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
});
