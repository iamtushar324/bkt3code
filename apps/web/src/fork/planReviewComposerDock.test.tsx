import type { ReactNode } from "react";
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ComposerScrollSurface,
  PlanReviewComposerDock,
  PlanReviewConversationComposerTarget,
  resetPlanReviewComposerDockForTests,
  shouldRestDockedComposer,
  shouldShowPlanFollowUpDrawer,
  usePlanReviewComposerScrollSurface,
} from "./planReviewComposerDock";

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly style = {};
  className = "";
  nodeValue: string | null = null;

  constructor(
    name: string,
    readonly ownerDocument: TestNode | null = null,
    readonly nodeType = 1,
  ) {
    this.nodeName = name.toUpperCase();
    this.tagName = this.nodeName;
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.nodeValue = value;
  }

  get textContent(): string {
    return this.nodeValue ?? this.childNodes.map((child) => child.textContent).join("");
  }

  appendChild(child: TestNode) {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(child: TestNode) {
    this.appendChild(child);
  }

  insertBefore(child: TestNode, before: TestNode | null) {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: TestNode) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    this.parentNode?.removeChild(this);
  }

  createElement(name: string) {
    return new TestNode(name, this);
  }

  createTextNode(value: string) {
    const node = new TestNode("#text", this, 3);
    node.nodeValue = value;
    return node;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  addEventListener() {}
  removeEventListener() {}
}

function installTestDom() {
  const document = new TestNode("#document", null, 9);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    document,
    HTMLIFrameElement: TestNode,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("HTMLIFrameElement", TestNode);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return document;
}

function findByAttribute(root: TestNode, name: string): TestNode | null {
  if (root.attributes.has(name)) return root;
  for (const child of root.childNodes) {
    const match = findByAttribute(child, name);
    if (match) return match;
  }
  return null;
}

async function render(root: { render: (children: ReactNode) => void }, children: ReactNode) {
  flushSync(() => root.render(children));
  await Promise.resolve();
  flushSync(() => undefined);
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
  beforeEach(() => resetPlanReviewComposerDockForTests());

  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    vi.unstubAllGlobals();
  });

  it("moves the same mounted composer into the review rail and back home", async () => {
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);

    try {
      await render(root, <Harness reviewOpen={false} />);
      const composer = findByAttribute(container, "data-composer-fixture");
      const home = findByAttribute(container, "data-plan-review-composer-home");
      expect(composer).not.toBeNull();
      expect(home?.textContent).toBe("Composer draft");

      await render(root, <Harness reviewOpen />);
      const target = findByAttribute(container, "data-plan-review-composer-target");
      expect(findByAttribute(container, "data-composer-fixture")).toBe(composer);
      expect(target?.textContent).toBe("Composer draft");
      expect(home?.textContent).toBe("");

      await render(root, <Harness reviewOpen={false} />);
      expect(findByAttribute(container, "data-composer-fixture")).toBe(composer);
      expect(home?.textContent).toBe("Composer draft");
    } finally {
      flushSync(() => root.unmount());
    }
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
    const document = installTestDom();
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const timeline = document.createElement("div") as unknown as HTMLElement;
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

    try {
      await render(root, <Probe />);
      expect(captured.surface?.getTimelineScrollableNode()).toBe(timeline);
      expect(captured.surface?.isTimelineAtLogicalEnd()).toBe(false);
      expect(captured.surface?.timelineOverflows).toBe(false);
    } finally {
      flushSync(() => root.unmount());
    }
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
