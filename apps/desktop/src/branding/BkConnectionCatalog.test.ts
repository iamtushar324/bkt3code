import { describe, expect, it } from "vite-plus/test";

import { BK_RUNTIME_BRANDS } from "./BkBrand.ts";
import { resolveDesktopConnectionCatalogPath } from "./BkConnectionCatalog.ts";

const input = {
  stateDir: "/Users/alice/.t3/userdata",
  appDataDirectory: "/Users/alice/Library/Application Support",
  joinPath: (...parts: ReadonlyArray<string>) => parts.join("/"),
};

describe("BkConnectionCatalog", () => {
  it("keeps upstream desktop catalogs in the environment state directory", () => {
    expect(resolveDesktopConnectionCatalogPath(input, undefined)).toBe(
      "/Users/alice/.t3/userdata/connection-catalog.json",
    );
  });

  it("isolates staging and production catalogs by desktop identity", () => {
    expect(resolveDesktopConnectionCatalogPath(input, BK_RUNTIME_BRANDS.staging)).toBe(
      "/Users/alice/Library/Application Support/bkt3code-staging/connection-catalog.json",
    );
    expect(resolveDesktopConnectionCatalogPath(input, BK_RUNTIME_BRANDS.production)).toBe(
      "/Users/alice/Library/Application Support/bkt3code/connection-catalog.json",
    );
  });
});
