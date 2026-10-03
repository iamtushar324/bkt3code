// T3-CUSTOM(expbkt3): unstarted drafts use the normal sidebar's composer data path.
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { derivePhaseSidebarRepositoryKey } from "@t3tools/client-runtime/state/phase-sidebar";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import {
  composerDraftHasUserContent,
  DraftId,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../../composerDraftStore";
import type { Project } from "../../types";

export const PHASE_SIDEBAR_DRAFTS_SECTION_KEY = "drafts:unstarted";

export interface PhaseSidebarDraftScope {
  readonly projectByKey: ReadonlyMap<string, Project>;
  readonly repositoryKeys: ReadonlyArray<string>;
  readonly routeDraftId: string | null;
}

export interface PhaseSidebarDraftSource {
  readonly draftThreadsByThreadKey: Readonly<Record<string, DraftSessionState>>;
  readonly draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState>>;
}

export interface PhaseSidebarDraftRowData {
  readonly draftId: DraftId;
  readonly session: DraftSessionState;
  readonly composer: ComposerThreadDraftState;
}

export interface PhaseSidebarFrozenDraft {
  readonly routeDraftId: string | null;
  readonly row: PhaseSidebarDraftRowData | null;
}

export function capturePhaseSidebarDraft(
  source: PhaseSidebarDraftSource,
  routeDraftId: string | null,
): PhaseSidebarFrozenDraft {
  const session = routeDraftId === null ? undefined : source.draftThreadsByThreadKey[routeDraftId];
  const composer = routeDraftId === null ? undefined : source.draftsByThreadKey[routeDraftId];
  return {
    routeDraftId,
    row:
      routeDraftId !== null &&
      session &&
      session.promotedTo == null &&
      composer &&
      composerDraftHasUserContent(composer)
        ? { draftId: DraftId.make(routeDraftId), session, composer }
        : null,
  };
}

export function selectPhaseSidebarDrafts(
  source: PhaseSidebarDraftSource,
  scope: PhaseSidebarDraftScope,
  frozen: PhaseSidebarFrozenDraft,
): ReadonlyArray<PhaseSidebarDraftRowData> {
  const rows: PhaseSidebarDraftRowData[] = [];
  for (const [draftKey, session] of Object.entries(source.draftThreadsByThreadKey)) {
    // Gate on the live session even when the active row uses a frozen preview.
    if (session.promotedTo != null) continue;
    const projectKey = scopedProjectKey(scopeProjectRef(session.environmentId, session.projectId));
    const project = scope.projectByKey.get(projectKey);
    if (
      scope.repositoryKeys.length > 0 &&
      !scope.repositoryKeys.includes(
        project ? derivePhaseSidebarRepositoryKey(project) : projectKey,
      )
    ) {
      continue;
    }
    if (draftKey === scope.routeDraftId) {
      if (frozen.routeDraftId === draftKey && frozen.row !== null) rows.push(frozen.row);
      continue;
    }
    const composer = source.draftsByThreadKey[draftKey];
    if (composer && composerDraftHasUserContent(composer)) {
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
  }
  return rows.sort((left, right) => right.session.createdAt.localeCompare(left.session.createdAt));
}

export function phaseSidebarDraftPreview(composer: ComposerThreadDraftState): string {
  const prompt =
    replaceComposerContextReferences(composer.prompt, (occurrence) => occurrence.label)
      .trim()
      .split("\n", 1)[0] ?? "";
  if (prompt.length > 0) return prompt;
  // Hydrated images mirror persisted images; count each saved image only once.
  const count =
    Math.max(composer.images.length, composer.persistedAttachments.length) +
    composer.files.length +
    composer.terminalContexts.length +
    composer.previewAnnotations.length +
    composer.reviewComments.length +
    composer.threadContexts.length;
  return `${count} attachment${count === 1 ? "" : "s"}`;
}
