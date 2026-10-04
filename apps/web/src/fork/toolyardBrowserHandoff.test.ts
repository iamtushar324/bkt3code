/** T3-CUSTOM(expbkt3): Browser handoffs preserve user activation and use the native OS opener. */
import { afterEach, expect, it, vi } from "vite-plus/test";
const nativeOpen = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({ shell: { openExternal: nativeOpen } }) }));
import { createToolyardBrowserHandoffTarget } from "./toolyardBrowserHandoff";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("reserves a web tab before the async code request and isolates its opener", async () => {
  const replace = vi.fn();
  const close = vi.fn();
  const tab = { opener: {}, location: { replace }, close };
  const open = vi.fn(() => tab);
  vi.stubGlobal("window", { open });
  const target = createToolyardBrowserHandoffTarget();
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(tab.opener).toBeNull();
  await target.open("https://toolyard.test/handoff?code=one-use");
  target.close();
  expect(replace).toHaveBeenCalledWith("https://toolyard.test/handoff?code=one-use");
  expect(close).not.toHaveBeenCalled();
});
it("closes an unused tab after failed request and reports popup blocking", () => {
  const close = vi.fn();
  vi.stubGlobal("window", { open: () => ({ opener: {}, close }) });
  createToolyardBrowserHandoffTarget().close();
  expect(close).toHaveBeenCalledOnce();
  vi.stubGlobal("window", { open: () => null });
  expect(() => createToolyardBrowserHandoffTarget()).toThrow("blocked");
});
it("uses the desktop default browser rather than a web or integrated preview tab", async () => {
  const open = vi.fn();
  vi.stubGlobal("window", { desktopBridge: {}, open });
  const target = createToolyardBrowserHandoffTarget();
  await target.open("https://toolyard.test/handoff?code=one-use");
  target.close();
  expect(nativeOpen).toHaveBeenCalledWith("https://toolyard.test/handoff?code=one-use");
  expect(open).not.toHaveBeenCalled();
});
