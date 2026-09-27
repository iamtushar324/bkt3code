import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import type { DraftId } from "../composerDraftStore";
import { shouldNavigateAfterDraftPromotion } from "../draftPromotionNavigation";
import { resolveThreadRouteTarget } from "../threadRoutes";

export function useDraftPromotionNavigationGuard(originDraftId: DraftId | null) {
  const router = useRouter();

  return useCallback(() => {
    if (originDraftId === null) {
      return false;
    }

    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return shouldNavigateAfterDraftPromotion({
      originDraftId,
      currentRouteTarget: resolveThreadRouteTarget(currentRouteParams),
    });
  }, [originDraftId, router]);
}
