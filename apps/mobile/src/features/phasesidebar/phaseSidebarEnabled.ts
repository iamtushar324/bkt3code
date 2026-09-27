// T3-CUSTOM(expbkt3): the experimental phase-sidebar opt-in, as a hook.
//
// Mirrors features/threads/use-thread-list-v2-enabled.ts. The resolver itself
// lives in phaseSidebarPreferences.ts so it stays testable without pulling
// react-native onto the import graph.
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolvePhaseSidebarEnabled } from "./phaseSidebarPreferences";

export function usePhaseSidebarEnabled(): boolean {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  return resolvePhaseSidebarEnabled({
    preference: loaded ? preferencesResult.value.experimentalPhaseSidebarEnabled : undefined,
    preferencesLoaded: loaded,
  });
}
