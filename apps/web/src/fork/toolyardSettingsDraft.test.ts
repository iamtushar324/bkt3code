/** T3-CUSTOM(expbkt3): Settings drafts survive remount/reload and disappear on logout. */
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  clearToolyardSettingsDrafts,
  readToolyardSettingsDraft,
  toolyardDraftKey,
  writeToolyardSettingsDraft,
} from "./toolyardSettingsDraft";
afterEach(() => vi.unstubAllGlobals());
it("recovers a user draft after navigation and clears it on logout without other app state", () => {
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
  vi.stubGlobal("window", { sessionStorage: store });
  const a = toolyardDraftKey("stage", "user_a");
  const b = toolyardDraftKey("stage", "user_b");
  const other = toolyardDraftKey("stable", "user_a");
  const draft = { baseUrl: "https://toolyard.test", enabled: true, revision: 3 };
  writeToolyardSettingsDraft(a, draft);
  expect(readToolyardSettingsDraft(a)).toEqual(draft);
  expect(readToolyardSettingsDraft(b)).toBeNull();
  expect(readToolyardSettingsDraft(other)).toBeNull();
  store.setItem("other-app-setting", "preserve");
  clearToolyardSettingsDrafts();
  expect(readToolyardSettingsDraft(a)).toBeNull();
  expect(store.getItem("other-app-setting")).toBe("preserve");
});
it("retains the in-memory path when browser storage is unavailable", () => {
  vi.stubGlobal("window", {});
  expect(() =>
    writeToolyardSettingsDraft("draft", { baseUrl: "", enabled: false, revision: 0 }),
  ).not.toThrow();
  expect(readToolyardSettingsDraft("draft")).toBeNull();
  expect(() => clearToolyardSettingsDrafts()).not.toThrow();
});

it("stores and recovers only public fields even when a caller includes credentials", () => {
  const values = new Map<string, string>();
  const store = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("window", { sessionStorage: store });
  const draft = {
    baseUrl: "https://toolyard.test",
    enabled: true,
    revision: 1,
    mode: "api-key" as const,
    apiKey: "never-store-this",
    adminToken: "also-secret",
  };
  writeToolyardSettingsDraft("api", draft);
  expect(store.getItem("api")).not.toContain("secret");
  expect(store.getItem("api")).not.toContain("never-store-this");
  store.setItem("api", JSON.stringify(draft));
  expect(readToolyardSettingsDraft("api")).toEqual({
    baseUrl: draft.baseUrl,
    enabled: true,
    revision: 1,
    mode: "api-key",
  });
});
