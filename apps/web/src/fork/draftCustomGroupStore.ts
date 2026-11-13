// T3-CUSTOM(expbkt3): the custom group a new session lands in.
//
// A custom group header's "+" opens a draft like the New thread button does,
// but the session it becomes must be filed in that group from its first send.
// The draft does not exist on the server yet, so the choice waits here, keyed
// by the draft's thread id, until the send builds the thread's create input
// (`threadCreationForkFields`), which then names the group explicitly; an
// explicit group outranks the host's default group on the server.
//
// Persisted with the drafts themselves (both live in local storage), so a
// reload keeps the choice. The sidebar prunes entries whose draft is gone
// (sent or discarded) with `pruneDraftCustomGroupTargets`.
import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

export const DRAFT_CUSTOM_GROUP_STORAGE_KEY = "t3code:draft-custom-groups:v1";

/** Group label by draft thread id. */
export type DraftCustomGroupTargets = Readonly<Record<string, string>>;

const NO_TARGETS: DraftCustomGroupTargets = {};

/** Files the draft under `label`; null forgets the choice (the session then joins no group). */
export function setDraftCustomGroupTarget(
  targets: DraftCustomGroupTargets,
  threadId: string,
  label: string | null,
): DraftCustomGroupTargets {
  const trimmed = label?.trim() ?? "";
  if (trimmed.length === 0) {
    if (!(threadId in targets)) return targets;
    const rest: Record<string, string> = { ...targets };
    delete rest[threadId];
    return Object.keys(rest).length === 0 ? NO_TARGETS : rest;
  }
  return targets[threadId] === trimmed ? targets : { ...targets, [threadId]: trimmed };
}

/** Drops every choice whose draft no longer exists. Unchanged input when nothing goes. */
export function pruneDraftCustomGroupTargets(
  targets: DraftCustomGroupTargets,
  liveDraftThreadIds: ReadonlySet<string>,
): DraftCustomGroupTargets {
  const ids = Object.keys(targets);
  if (ids.every((id) => liveDraftThreadIds.has(id))) return targets;
  const kept: Record<string, string> = {};
  for (const id of ids) {
    const label = targets[id];
    if (label !== undefined && liveDraftThreadIds.has(id)) kept[id] = label;
  }
  return Object.keys(kept).length === 0 ? NO_TARGETS : kept;
}

/** The create-input field for a draft: `{ customGroup }` when one was chosen, else nothing. */
export function draftCustomGroupCreateFields(
  targets: DraftCustomGroupTargets,
  threadId: ThreadId | string | null | undefined,
): { readonly customGroup?: string } {
  if (threadId === null || threadId === undefined) return {};
  const label = targets[threadId];
  return label === undefined ? {} : { customGroup: label };
}

function sanitizeTargets(value: unknown): DraftCustomGroupTargets {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return NO_TARGETS;
  let targets = NO_TARGETS;
  for (const [threadId, label] of Object.entries(value)) {
    if (threadId.length > 0 && typeof label === "string") {
      targets = setDraftCustomGroupTarget(targets, threadId, label);
    }
  }
  return targets;
}

interface DraftCustomGroupStoreState {
  readonly targets: DraftCustomGroupTargets;
  setTarget: (threadId: string, label: string | null) => void;
  prune: (liveDraftThreadIds: ReadonlySet<string>) => void;
}

export const useDraftCustomGroupStore = create<DraftCustomGroupStoreState>()(
  persist(
    (set) => ({
      targets: NO_TARGETS,
      setTarget: (threadId, label) =>
        set((state) => {
          const next = setDraftCustomGroupTarget(state.targets, threadId, label);
          return next === state.targets ? state : { targets: next };
        }),
      prune: (liveDraftThreadIds) =>
        set((state) => {
          const next = pruneDraftCustomGroupTargets(state.targets, liveDraftThreadIds);
          return next === state.targets ? state : { targets: next };
        }),
    }),
    {
      name: DRAFT_CUSTOM_GROUP_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ targets: state.targets }),
      merge: (persisted, current) => ({
        ...current,
        targets: sanitizeTargets(
          persisted && typeof persisted === "object"
            ? (persisted as { readonly targets?: unknown }).targets
            : undefined,
        ),
      }),
    },
  ),
);

/** The group chosen for a draft, read when its first send builds the create input. */
export function readDraftCustomGroupCreateFields(threadId: ThreadId | string | null | undefined): {
  readonly customGroup?: string;
} {
  return draftCustomGroupCreateFields(useDraftCustomGroupStore.getState().targets, threadId);
}
