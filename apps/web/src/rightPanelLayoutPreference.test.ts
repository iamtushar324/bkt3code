/**
 * T3-CUSTOM(expbkt3): the right panel's shape has to survive a thread switch.
 *
 * The hook itself is a thin `useLocalStorage` wrapper, so the behaviour worth
 * pinning is the durable part: which key the choice lands under, that it
 * round-trips, and that a fresh workspace still gets upstream's side-by-side
 * default. That is what a thread switch reads back.
 */
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

async function loadWithStorage(storage: Storage) {
  vi.stubGlobal("window", { localStorage: storage });
  vi.stubGlobal("localStorage", storage);
  const storageModule = await import("./hooks/useLocalStorage");
  const preferenceModule = await import("./rightPanelLayoutPreference");
  return { ...storageModule, ...preferenceModule };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("right panel layout preference", () => {
  it("reads as side-by-side until the user picks full screen", async () => {
    const { getLocalStorageItem, RIGHT_PANEL_MAXIMIZED_STORAGE_KEY } =
      await loadWithStorage(createStorage());

    expect(getLocalStorageItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, Schema.Boolean)).toBe(null);
  });

  it("round-trips full screen, so the next thread opens the same way", async () => {
    const storage = createStorage();
    const { setLocalStorageItem, RIGHT_PANEL_MAXIMIZED_STORAGE_KEY } =
      await loadWithStorage(storage);

    setLocalStorageItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, true, Schema.Boolean);

    // Re-import against the same storage: this is what opening a panel in
    // another thread — or reloading the app — actually sees.
    vi.resetModules();
    const reloaded = await loadWithStorage(storage);
    expect(
      reloaded.getLocalStorageItem(reloaded.RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, Schema.Boolean),
    ).toBe(true);
  });

  it("goes back to side-by-side when the user toggles out of full screen", async () => {
    const storage = createStorage();
    const { getLocalStorageItem, setLocalStorageItem, RIGHT_PANEL_MAXIMIZED_STORAGE_KEY } =
      await loadWithStorage(storage);

    setLocalStorageItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, true, Schema.Boolean);
    setLocalStorageItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, false, Schema.Boolean);

    expect(getLocalStorageItem(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY, Schema.Boolean)).toBe(false);
  });

  it("keeps the panel width under its own durable key", async () => {
    // Width already persists upstream; the preference must not collide with it.
    const { RIGHT_PANEL_MAXIMIZED_STORAGE_KEY } = await loadWithStorage(createStorage());
    expect(RIGHT_PANEL_MAXIMIZED_STORAGE_KEY).not.toBe("t3code:preview-panel-width");
  });
});
