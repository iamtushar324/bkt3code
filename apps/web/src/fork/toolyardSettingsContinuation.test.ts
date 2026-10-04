/** T3-CUSTOM(expbkt3): Browser draft survives auth routing and logout clears it. */
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  prepareToolyardSettingsContinuation,
  pendingToolyardSettingsContinuation,
  clearToolyardSettingsContinuation,
} from "./toolyardSettingsContinuation";
import { clearToolyardSettingsDrafts } from "./toolyardSettingsDraft";
afterEach(() => vi.unstubAllGlobals());
it("captures before an unauthenticated redirect, restores after reload, and clears on logout", () => {
  const values: Record<string, string> = {};
  const store = new Proxy(
    {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
      removeItem: (key: string) => {
        delete values[key];
      },
    },
    {
      ownKeys: () => Object.keys(values),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    sessionStorage: store,
    location: {
      hash: "#toolyard-settings=public-draft",
      pathname: "/settings/experiments",
      search: "",
    },
    history: { state: null, replaceState },
  });
  prepareToolyardSettingsContinuation();
  expect(replaceState).toHaveBeenCalledWith(null, "", "/settings/experiments");
  vi.stubGlobal("window", {
    sessionStorage: store,
    location: { hash: "", pathname: "/pair", search: "" },
  });
  expect(pendingToolyardSettingsContinuation()).toBe("#toolyard-settings=public-draft");
  clearToolyardSettingsDrafts();
  expect(pendingToolyardSettingsContinuation()).toBeNull();
});
it("ignores unrelated or oversized fragments and clears a consumed link", () => {
  const getItem = vi.fn(() => "#toolyard-settings=public-draft");
  const setItem = vi.fn();
  const removeItem = vi.fn();
  vi.stubGlobal("window", {
    sessionStorage: { getItem, setItem, removeItem },
    location: { hash: "#other=test" },
  });
  prepareToolyardSettingsContinuation();
  expect(setItem).not.toHaveBeenCalled();
  window.location.hash = "#toolyard-settings=" + "x".repeat(8192);
  prepareToolyardSettingsContinuation();
  expect(setItem).not.toHaveBeenCalled();
  clearToolyardSettingsContinuation();
  expect(removeItem).toHaveBeenCalledOnce();
});
