import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => store.delete(key),
    setItem: (key, value) => store.set(key, value),
  };
}

describe("thread visit persistence", () => {
  let localStorageStub: Storage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorageStub = createLocalStorageStub();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      localStorage: localStorageStub,
    });
    vi.stubGlobal("localStorage", localStorageStub);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("restores a read marker after an immediate refresh", async () => {
    const threadKey = "environment:thread-1";
    const visitedAt = "2026-08-02T17:00:00.000Z";
    const firstLoad = await import("./uiStateStore");

    firstLoad.useUiStateStore.getState().markThreadVisited(threadKey, visitedAt);

    expect(firstLoad.useUiStateStore.getState().threadLastVisitedAtById[threadKey]).toBe(visitedAt);

    vi.resetModules();
    const refreshed = await import("./uiStateStore");
    expect(refreshed.useUiStateStore.getState().threadLastVisitedAtById[threadKey]).toBe(visitedAt);
  });

  it("does not let an older queued snapshot restore unread after the visit is persisted", async () => {
    const threadKey = "environment:thread-1";
    const oldVisitedAt = "2026-08-02T16:59:00.000Z";
    const visitedAt = "2026-08-02T17:00:00.000Z";
    localStorageStub.setItem(
      "t3code:ui-state:v1",
      JSON.stringify({
        threadLastVisitedAtById: { [threadKey]: oldVisitedAt },
      }),
    );
    const firstLoad = await import("./uiStateStore");

    firstLoad.useUiStateStore.getState().setProjectExpanded("project-1", false);
    firstLoad.useUiStateStore.getState().markThreadVisited(threadKey, visitedAt);
    await vi.advanceTimersByTimeAsync(500);

    vi.resetModules();
    const restarted = await import("./uiStateStore");
    expect(restarted.useUiStateStore.getState().threadLastVisitedAtById[threadKey]).toBe(visitedAt);
  });
});
