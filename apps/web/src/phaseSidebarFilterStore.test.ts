import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  PHASE_SIDEBAR_FILTER_STORAGE_KEY,
  usePhaseSidebarFilterStore,
} from "./phaseSidebarFilterStore";

describe("phase sidebar filter store", () => {
  beforeEach(() => {
    usePhaseSidebarFilterStore.setState({
      repositoryKeys: [],
      phaseIds: [],
      providerKinds: [],
    });
  });

  it("uses a versioned persistence key and toggles independent facets", () => {
    expect(PHASE_SIDEBAR_FILTER_STORAGE_KEY).toBe("t3code:phase-sidebar-filters:v1");
    const state = usePhaseSidebarFilterStore.getState();
    state.toggleRepository("repo-1");
    state.toggleRepository("repo-2");
    state.togglePhase("ready");
    state.toggleProvider("codex");

    expect(usePhaseSidebarFilterStore.getState()).toMatchObject({
      repositoryKeys: ["repo-1", "repo-2"],
      phaseIds: ["ready"],
      providerKinds: ["codex"],
    });
    usePhaseSidebarFilterStore.getState().toggleRepository("repo-1");
    expect(usePhaseSidebarFilterStore.getState().repositoryKeys).toEqual(["repo-2"]);
  });

  it("clears selections without changing store actions", () => {
    usePhaseSidebarFilterStore.setState({
      repositoryKeys: ["repo-1"],
      phaseIds: ["planning"],
      providerKinds: ["codex"],
    });
    usePhaseSidebarFilterStore.getState().clearAll();
    const state = usePhaseSidebarFilterStore.getState();
    expect(state.repositoryKeys).toEqual([]);
    expect(state.phaseIds).toEqual([]);
    expect(state.providerKinds).toEqual([]);
    expect(state.toggleRepository).toBeTypeOf("function");
  });

  // T3-CUSTOM(expbkt3): in-group ordering rides in the same store as the filters.
  it("keeps sort preferences out of the filter reset", () => {
    usePhaseSidebarFilterStore.setState({ repositoryKeys: ["repo-1"] });
    usePhaseSidebarFilterStore.getState().setSortDirection("oldest_first");
    usePhaseSidebarFilterStore.getState().togglePriorityFirst();
    expect(usePhaseSidebarFilterStore.getState().sort).toEqual({
      direction: "oldest_first",
      priorityFirst: false,
    });

    usePhaseSidebarFilterStore.getState().clearAll();
    expect(usePhaseSidebarFilterStore.getState().repositoryKeys).toEqual([]);
    expect(usePhaseSidebarFilterStore.getState().sort).toEqual({
      direction: "oldest_first",
      priorityFirst: false,
    });
    usePhaseSidebarFilterStore.getState().setSortDirection("newest_first");
    usePhaseSidebarFilterStore.getState().togglePriorityFirst();
  });

  it("removes stale repository and provider values only when explicitly reconciled", () => {
    usePhaseSidebarFilterStore.setState({
      repositoryKeys: ["repo-1", "stale-repo"],
      phaseIds: ["ready"],
      providerKinds: ["codex", "stale-provider"],
    });
    expect(usePhaseSidebarFilterStore.getState().repositoryKeys).toContain("stale-repo");

    usePhaseSidebarFilterStore.getState().reconcile({
      repositoryKeys: new Set(["repo-1"]),
      providerKinds: new Set(["codex"]),
      assignmentAvailable: true,
    });
    expect(usePhaseSidebarFilterStore.getState()).toMatchObject({
      repositoryKeys: ["repo-1"],
      phaseIds: ["ready"],
      providerKinds: ["codex"],
    });
  });
});
