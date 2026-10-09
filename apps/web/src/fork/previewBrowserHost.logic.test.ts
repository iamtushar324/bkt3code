import type { PreviewBrowserHostSetting } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewRuntime } from "./previewBrowserHost.logic";

const runtime = (
  serverBrowser: boolean,
  desktopBrowser: boolean,
  previewBrowser: PreviewBrowserHostSetting,
) => resolvePreviewRuntime({ serverBrowser, desktopBrowser, previewBrowser });

describe("resolvePreviewRuntime", () => {
  it("keeps the desktop runtime when the environment has no server browser", () => {
    expect(runtime(false, true, "server")).toBeUndefined();
    expect(runtime(false, false, "client")).toBeUndefined();
  });

  it("opens tabs in the desktop app when the host prefers the client browser", () => {
    expect(runtime(true, true, "client")).toBeUndefined();
  });

  it("falls back to the server browser for clients without their own browser", () => {
    expect(runtime(true, false, "client")).toBe("server");
  });

  it("uses the server browser everywhere when the host prefers it", () => {
    expect(runtime(true, true, "server")).toBe("server");
    expect(runtime(true, false, "server")).toBe("server");
  });
});
