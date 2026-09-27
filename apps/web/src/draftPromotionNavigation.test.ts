import { describe, expect, it } from "vite-plus/test";
import type { DraftId } from "./composerDraftStore";
import { shouldNavigateAfterDraftPromotion } from "./draftPromotionNavigation";

const originDraftId = "new-thread-draft" as DraftId;

describe("draft promotion navigation", () => {
  it("keeps the user's newer thread selection when creation finishes late", () => {
    expect(
      shouldNavigateAfterDraftPromotion({
        originDraftId,
        currentRouteTarget: {
          kind: "server",
          threadRef: {
            environmentId: "environment-a" as never,
            threadId: "other-thread" as never,
          },
        },
      }),
    ).toBe(false);
  });

  it("canonicalizes the route while the originating draft is still active", () => {
    expect(
      shouldNavigateAfterDraftPromotion({
        originDraftId,
        currentRouteTarget: { kind: "draft", draftId: originDraftId },
      }),
    ).toBe(true);
  });

  it("keeps a different draft selected when creation finishes late", () => {
    expect(
      shouldNavigateAfterDraftPromotion({
        originDraftId,
        currentRouteTarget: { kind: "draft", draftId: "other-draft" as DraftId },
      }),
    ).toBe(false);
  });
});
