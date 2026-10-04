/** T3-CUSTOM(expbkt3): Settings drafts survive remount/reload and disappear on logout. */
import { afterEach, expect, it, vi } from "vitest";
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
