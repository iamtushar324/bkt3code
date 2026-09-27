import type { DraftId } from "./composerDraftStore";
import type { ThreadRouteTarget } from "./threadRoutes";

export function shouldNavigateAfterDraftPromotion(input: {
  originDraftId: DraftId;
  currentRouteTarget: ThreadRouteTarget | null;
}): boolean {
  return (
    input.currentRouteTarget?.kind === "draft" &&
    input.currentRouteTarget.draftId === input.originDraftId
  );
}
