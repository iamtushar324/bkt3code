// T3-CUSTOM(expbkt3): session-tree expansion store coverage.
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { usePhaseSidebarTreeStore } from "./phaseSidebarTreeStore";

const reset = () => usePhaseSidebarTreeStore.setState({ expandedKeys: [] });
const state = () => usePhaseSidebarTreeStore.getState();

describe("phaseSidebarTreeStore", () => {
  beforeEach(reset);

  it("starts with every subtree collapsed", () => {
    expect(state().expandedKeys).toEqual([]);
  });

  it("toggles a key open and closed again", () => {
    state().toggle("env:thread-1");
    expect(state().expandedKeys).toEqual(["env:thread-1"]);

    state().toggle("env:thread-1");
    expect(state().expandedKeys).toEqual([]);
  });

  it("expands a whole subtree in one write", () => {
    state().setExpanded(["a", "b", "c"], true);

    expect(state().expandedKeys.toSorted()).toEqual(["a", "b", "c"]);
  });

  it("collapses a whole subtree without disturbing unrelated keys", () => {
    state().setExpanded(["a", "b", "keep"], true);
    state().setExpanded(["a", "b"], false);

    expect(state().expandedKeys).toEqual(["keep"]);
  });

  it("never records a key twice", () => {
    state().setExpanded("a", true);
    state().setExpanded(["a", "b"], true);

    expect(state().expandedKeys.toSorted()).toEqual(["a", "b"]);
  });

  it("keeps the same state object when nothing changes", () => {
    state().setExpanded("a", true);
    const before = state().expandedKeys;
    state().setExpanded("a", true);

    // Referential stability matters: the sidebar memoizes on this array.
    expect(state().expandedKeys).toBe(before);
  });

  it("ignores an empty update", () => {
    const before = state().expandedKeys;
    state().setExpanded([], true);

    expect(state().expandedKeys).toBe(before);
  });
});
