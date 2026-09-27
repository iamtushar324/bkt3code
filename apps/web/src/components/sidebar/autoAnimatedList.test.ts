import { describe, expect, it, vi } from "vite-plus/test";

const animated = vi.hoisted(() => ({
  calls: [] as Array<{ node: unknown; config: unknown }>,
  destroyed: 0,
  disabled: 0,
  omitDestroy: false,
}));

vi.mock("@formkit/auto-animate", () => ({
  autoAnimate: (node: unknown, config: unknown) => {
    animated.calls.push({ node, config });
    const disable = () => {
      animated.disabled += 1;
    };
    return animated.omitDestroy
      ? { disable }
      : {
          disable,
          destroy: () => {
            animated.destroyed += 1;
          },
        };
  },
}));

import { autoAnimatedListRef } from "./autoAnimatedList";

function reset() {
  animated.calls = [];
  animated.destroyed = 0;
  animated.disabled = 0;
  animated.omitDestroy = false;
}

describe("autoAnimatedListRef", () => {
  it("releases the animation controller when the list unmounts", () => {
    reset();
    const list = {} as HTMLElement;

    const cleanup = autoAnimatedListRef(list);

    expect(animated.calls).toHaveLength(1);
    expect(animated.calls[0]?.node).toBe(list);
    expect(animated.destroyed).toBe(0);

    // A list that keeps its MutationObserver after unmounting is where
    // auto-animate re-inserts a row it is animating out, and the row then
    // bounces between the two lists forever.
    cleanup?.();
    expect(animated.destroyed).toBe(1);
  });

  it("falls back to disabling when the build predates controller.destroy", () => {
    reset();
    animated.omitDestroy = true;

    autoAnimatedListRef({} as HTMLElement)?.();

    expect(animated.disabled).toBe(1);
  });

  it("animates nothing when React hands it a detached ref", () => {
    reset();

    expect(autoAnimatedListRef(null)).toBeUndefined();
    expect(animated.calls).toHaveLength(0);
  });

  it("keeps one identity across renders, so a list is never re-attached", () => {
    // A ref callback recreated per render is detached and reattached every
    // render; auto-animate would then rebuild its observer on every keystroke.
    expect(autoAnimatedListRef).toBe(autoAnimatedListRef);
  });
});
