// T3-CUSTOM(expbkt3): remembers when each thread was last looked at.
//
// Feeds `buildPhaseSidebarRows`, which turns it into the row's unread dot via
// the shared `hasUnseenCompletion`. Persisted in device preferences rather than
// synced: "have *I* seen this" is per device, and mobile has no client-settings
// sync to hang it on. Pruning lives in phaseSidebarPreferences.ts.
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { pruneVisitTimestamps, removeVisitTimestamp } from "./phaseSidebarPreferences";

const EMPTY_VISITS: Readonly<Record<string, string>> = {};

export function usePhaseSidebarVisitTimestamps(): Readonly<Record<string, string>> {
  const result = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(result)
    ? (result.value.phaseSidebarVisitedAt ?? EMPTY_VISITS)
    : EMPTY_VISITS;
}

/** Records a visit. Call it when a thread is opened, not when it is rendered. */
export function useMarkPhaseSidebarThreadVisited(): (threadKey: string) => void {
  const visits = usePhaseSidebarVisitTimestamps();
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (threadKey: string) => {
      updatePreferences({
        phaseSidebarVisitedAt: pruneVisitTimestamps({
          ...visits,
          [threadKey]: new Date().toISOString(),
        }),
      });
    },
    [updatePreferences, visits],
  );
}

/** "Mark unread": forgets the visit so the row flags again. */
export function useClearPhaseSidebarThreadVisit(): (threadKey: string) => void {
  const visits = usePhaseSidebarVisitTimestamps();
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (threadKey: string) => {
      const next = removeVisitTimestamp(visits, threadKey);
      if (next !== visits) updatePreferences({ phaseSidebarVisitedAt: next });
    },
    [updatePreferences, visits],
  );
}
