import type { ReactNode } from "react";
import { useEffect } from "react";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";

import {
  type ComposerScrollSurface,
  PlanReviewComposerDock,
  PlanReviewConversationComposerTarget,
  resetPlanReviewComposerDockForTests,
  shouldRestDockedComposer,
  shouldShowPlanFollowUpDrawer,
  usePlanReviewComposerScrollSurface,
} from "./planReviewComposerDock";

function setup() {
  resetPlanReviewComposerDockForTests();
}

function mount(ui: ReactNode) {
  // The dock uses no links or router hooks, and the assertions read the DOM as soon as render
  // resolves rather than after the test router loads.
  return render(ui, { router: false });
}

function findByAttribute(root: HTMLElement, name: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${name}]`);
}

function Harness({ reviewOpen }: { readonly reviewOpen: boolean }) {
  return (
    <div>
      <PlanReviewComposerDock>
        <div data-composer-fixture>Composer draft</div>
      </PlanReviewComposerDock>
      {reviewOpen ? <PlanReviewConversationComposerTarget /> : null}
    </div>
  );
}

describe("plan review composer dock", () => {
  it("moves the same mounted composer into the review rail and back home", async () => {
    setup();
    await using screen = await mount(<Harness reviewOpen={false} />);
    const { container } = screen;
    const composer = findByAttribute(container, "data-composer-fixture");
    const home = findByAttribute(container, "data-plan-review-composer-home");
    expect(composer).not.toBeNull();
    expect(home?.textContent).toBe("Composer draft");

    await screen.rerender(<Harness reviewOpen />);
    const target = findByAttribute(container, "data-plan-review-composer-target");
    expect(findByAttribute(container, "data-composer-fixture")).toBe(composer);
    expect(target?.textContent).toBe("Composer draft");
    expect(home?.textContent).toBe("");

    await screen.rerender(<Harness reviewOpen={false} />);
    expect(findByAttribute(container, "data-composer-fixture")).toBe(composer);
    expect(home?.textContent).toBe("Composer draft");
  });
});

describe("resting a docked composer", () => {
  const docked = {
    isDocked: true,
    isFocusWithin: false,
    hasMultilinePrompt: false,
    hasExpandedChrome: false,
  };

  it("rests a docked composer nothing is focused in", () => {
    expect(shouldRestDockedComposer(docked)).toBe(true);
  });

  it("leaves the composer alone in its normal home", () => {
    expect(shouldRestDockedComposer({ ...docked, isDocked: false })).toBe(false);
  });

  it("stays expanded while the reviewer is typing in it", () => {
    expect(shouldRestDockedComposer({ ...docked, isFocusWithin: true })).toBe(false);
  });

  it("keeps a multiline draft readable", () => {
    expect(shouldRestDockedComposer({ ...docked, hasMultilinePrompt: true })).toBe(false);
  });

  it("does not collapse behind open composer chrome", () => {
    expect(shouldRestDockedComposer({ ...docked, hasExpandedChrome: true })).toBe(false);
  });
});

describe("the docked scroll surface", () => {
  it("passes chat's own timeline through while the composer is home", async () => {
    setup();
    const timeline = document.createElement("div");
    const captured: { surface: ComposerScrollSurface | null } = { surface: null };

    function Probe() {
      const surface = usePlanReviewComposerScrollSurface({
        getTimelineScrollableNode: () => timeline,
        isTimelineAtLogicalEnd: () => false,
        timelineOverflows: false,
      });
      useEffect(() => {
        captured.surface = surface;
      }, [surface]);
      return null;
    }

    await using _screen = await mount(<Probe />);
    expect(captured.surface?.getTimelineScrollableNode()).toBe(timeline);
    expect(captured.surface?.isTimelineAtLogicalEnd()).toBe(false);
    expect(captured.surface?.timelineOverflows).toBe(false);
  });
});

describe("the plan follow-up banner", () => {
  const waiting = {
    isDockedInPlanReview: false,
    showPlanFollowUpPrompt: true,
    hasActiveProposedPlan: true,
    isCollapsedMobile: false,
  };

  it("announces a waiting plan in the chat pane", () => {
    expect(shouldShowPlanFollowUpDrawer(waiting)).toBe(true);
  });

  it("stays out of plan review, where the plan is already the surface", () => {
    // Left in, it counts as composer chrome and pins the docked bar open in the
    // one state the docked bar is ever used in.
    expect(shouldShowPlanFollowUpDrawer({ ...waiting, isDockedInPlanReview: true })).toBe(false);
  });

  it("is absent when no plan is waiting", () => {
    expect(shouldShowPlanFollowUpDrawer({ ...waiting, hasActiveProposedPlan: false })).toBe(false);
    expect(shouldShowPlanFollowUpDrawer({ ...waiting, showPlanFollowUpPrompt: false })).toBe(false);
  });

  it("keeps the phone's collapsed row clear", () => {
    expect(shouldShowPlanFollowUpDrawer({ ...waiting, isCollapsedMobile: true })).toBe(false);
  });
});
